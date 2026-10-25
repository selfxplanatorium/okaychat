#!/bin/sh
# Browser worker firewall, applied inside the worker container's own network namespace at start (the host is
# untouched). Outbound connections are allowed by the uid that opens them:
#   jobs (job API)                      -> only the render slots' and the fetch server's ports, on loopback
#   slot users (render slots, Chromium) -> only the egress proxy, on loopback
#   scrape (fetch server, Scrapling)    -> only the egress proxy, on loopback
#   egress (the proxy)                  -> DNS to the configured resolvers, TCP to public addresses; private, loopback,
#                                          link-local, CGNAT, multicast, and reserved ranges are rejected
#   root                                -> only the job API's port, on loopback (health check)
# Replies on connections someone else opened (the app's job requests) are allowed. Everything else, UDP and
# IPv6 included, is rejected. The proxy repeats the address check per connection and picks a policy by uid;
# this makes it impossible to go around the proxy. See docs/research/browser-worker.md.
set -eu

: "${JOBS_UID:?}" "${SCRAPE_UID:?}" "${EGRESS_UID:?}" "${SLOT_UIDS:?}" "${SLOT_PORTS:?}" "${JOB_PORT:?}" "${EGRESS_PORT:?}" "${FETCH_PORT:?}"

NAMESERVERS_V4=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { print $2 }' /etc/resolv.conf)
NAMESERVERS_V6=$(awk '$1 == "nameserver" && $2 ~ /:/ { print $2 }' /etc/resolv.conf)
[ -n "$NAMESERVERS_V4$NAMESERVERS_V6" ] || { echo "browser-firewall: no nameserver in /etc/resolv.conf" >&2; exit 1; }

V4_BLOCKED="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24
192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4"
# Global unicast is 2000::/3; within it, Teredo/ORCHID/benchmarking (2001::/23), documentation (2001:db8::/32,
# 3fff::/20), and 6to4 (2002::/16), which can tunnel to private IPv4.
V6_BLOCKED="2001::/23 2001:db8::/32 2002::/16 3fff::/20"

rules_v4() {
  echo "*filter"
  echo ":INPUT ACCEPT [0:0]"
  echo ":FORWARD DROP [0:0]"
  echo ":OUTPUT DROP [0:0]"
  echo "-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
  for port in $SLOT_PORTS $FETCH_PORT; do
    echo "-A OUTPUT -o lo -p tcp -d 127.0.0.1 --dport $port -m owner --uid-owner $JOBS_UID -j ACCEPT"
  done
  for uid in $SLOT_UIDS $SCRAPE_UID; do
    echo "-A OUTPUT -o lo -p tcp -d 127.0.0.1 --dport $EGRESS_PORT -m owner --uid-owner $uid -j ACCEPT"
  done
  echo "-A OUTPUT -o lo -p tcp -d 127.0.0.1 --dport $JOB_PORT -m owner --uid-owner 0 -j ACCEPT"
  # DNS, only for the proxy user and only to the resolvers in /etc/resolv.conf: Docker's embedded DNS on
  # 127.0.0.11 on compose networks (its NAT rules pick the port), the host's resolvers on the default bridge.
  for ns in $NAMESERVERS_V4; do
    if [ "$ns" = 127.0.0.11 ]; then
      echo "-A OUTPUT -d $ns/32 -m owner --uid-owner $EGRESS_UID -j ACCEPT"
    else
      for proto in udp tcp; do echo "-A OUTPUT -d $ns/32 -p $proto --dport 53 -m owner --uid-owner $EGRESS_UID -j ACCEPT"; done
    fi
  done
  for range in $V4_BLOCKED; do
    echo "-A OUTPUT -d $range -m owner --uid-owner $EGRESS_UID -j REJECT"
  done
  echo "-A OUTPUT -p tcp -m owner --uid-owner $EGRESS_UID -j ACCEPT"
  echo "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset"
  echo "-A OUTPUT -j REJECT"
  echo "COMMIT"
}

rules_v6() {
  echo "*filter"
  echo ":INPUT ACCEPT [0:0]"
  echo ":FORWARD DROP [0:0]"
  echo ":OUTPUT DROP [0:0]"
  echo "-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
  for ns in $NAMESERVERS_V6; do
    for proto in udp tcp; do echo "-A OUTPUT -d $ns/128 -p $proto --dport 53 -m owner --uid-owner $EGRESS_UID -j ACCEPT"; done
  done
  for range in $V6_BLOCKED; do
    echo "-A OUTPUT -d $range -m owner --uid-owner $EGRESS_UID -j REJECT"
  done
  echo "-A OUTPUT -d 2000::/3 -p tcp -m owner --uid-owner $EGRESS_UID -j ACCEPT"
  echo "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset"
  echo "-A OUTPUT -j REJECT"
  echo "COMMIT"
}

# iptables-nft is the default; hosts whose kernel only has the legacy backend get that one.
for variant in "" -legacy; do
  if rules_v4 | "iptables$variant-restore" 2>/dev/null; then
    if [ -e /proc/net/if_inet6 ]; then
      rules_v6 | "ip6tables$variant-restore"
    fi
    iptables$variant -S OUTPUT | grep -q -- "--uid-owner $EGRESS_UID"
    exit 0
  fi
done
echo "browser-firewall: could not install the egress rules (needs CAP_NET_ADMIN and iptables in the kernel)" >&2
exit 1
