// Builds inner.bpf, the seccomp filter bubblewrap installs on every run_code process right before it execs
// the command (`bwrap --seccomp`). It is generated with libseccomp at image build time, for the build's
// architecture, so no hand-written BPF is involved. See docs/research/code-sandbox.md.
//
// The network boundary is the run's own network namespace, not this filter. The filter keeps model code from
// leaving or rebuilding that boundary and trims kernel surface the run never needs:
// - no new namespaces (user namespaces would hand it capabilities inside them), no mounts, no setns;
// - no io_uring (its IORING_OP_SOCKET creates sockets without the socket syscall), bpf, perf, userfaultfd, keys;
// - sockets only for AF_UNIX, AF_INET, AF_INET6 (loopback inside the namespace), and AF_NETLINK. AF_VSOCK and
//   other families that are not namespaced fail with EAFNOSUPPORT;
// - syscalls from another ABI (i386 int 0x80, x32) kill the process instead of slipping past these rules.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef CLONE_NEWTIME
#define CLONE_NEWTIME 0x00000080
#endif

static void check(int rc, const char *what) {
  if (rc < 0) {
    fprintf(stderr, "inner.bpf: %s: %s\n", what, strerror(-rc));
    exit(1);
  }
}

static void deny(scmp_filter_ctx ctx, const char *name, int err) {
  int nr = seccomp_syscall_resolve_name(name);
  // A syscall this architecture does not have (or only multiplexes) needs no rule.
  if (nr < 0) return;
  check(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(err), nr, 0), name);
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s OUTPUT\n", argv[0]);
    return 2;
  }
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  if (!ctx) return 1;
  check(seccomp_attr_set(ctx, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_KILL_PROCESS), "badarch");

  const char *denied[] = {
      "unshare", "setns", "mount", "umount", "umount2", "pivot_root", "chroot", "mount_setattr", "move_mount",
      "open_tree", "fsopen", "fsconfig", "fsmount", "fspick", "io_uring_setup", "io_uring_enter",
      "io_uring_register", "bpf", "perf_event_open", "userfaultfd", "keyctl", "add_key", "request_key",
      "name_to_handle_at", "open_by_handle_at", "quotactl", "quotactl_fd", "acct", "swapon", "swapoff",
      "sethostname", "setdomainname", "syslog", "vhangup", "kexec_load", "kexec_file_load", "init_module",
      "finit_module", "delete_module", "lookup_dcookie", "fanotify_init",
  };
  for (size_t i = 0; i < sizeof(denied) / sizeof(*denied); i++) deny(ctx, denied[i], EPERM);

  // clone3 passes its flags in memory a filter cannot read. ENOSYS makes glibc fall back to clone.
  int clone3 = seccomp_syscall_resolve_name("clone3");
  if (clone3 >= 0) check(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), clone3, 0), "clone3");
  const unsigned long ns_flags[] = {CLONE_NEWUSER, CLONE_NEWNS, CLONE_NEWNET, CLONE_NEWPID, CLONE_NEWIPC,
                                    CLONE_NEWUTS, CLONE_NEWCGROUP, CLONE_NEWTIME};
#if defined(__s390__) || defined(__s390x__)
  const unsigned int flags_arg = 1;  // s390 swaps clone's first two arguments.
#else
  const unsigned int flags_arg = 0;
#endif
  for (size_t i = 0; i < sizeof(ns_flags) / sizeof(*ns_flags); i++) {
    check(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1,
                           SCMP_CMP(flags_arg, SCMP_CMP_MASKED_EQ, ns_flags[i], ns_flags[i])),
          "clone");
  }

  // Only these families: 0 and 3-9, 11-15, and 17 upward are refused (AF_PACKET 17, AF_VSOCK 40, ...).
  const char *socket_calls[] = {"socket", "socketpair"};
  for (size_t s = 0; s < 2; s++) {
    int nr = seccomp_syscall_resolve_name(socket_calls[s]);
    if (nr < 0) continue;
    check(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), nr, 1, SCMP_A0(SCMP_CMP_GE, AF_NETLINK + 1)), "family");
    for (int family = 0; family < AF_NETLINK; family++) {
      if (family == AF_UNIX || family == AF_INET || family == AF_INET6) continue;
      check(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), nr, 1, SCMP_A0(SCMP_CMP_EQ, family)), "family");
    }
  }
  // socketcall multiplexes socket() on i386; that ABI is already killed above. On a native socketcall
  // architecture the arguments are in memory, so refuse it outright.
  deny(ctx, "socketcall", EAFNOSUPPORT);

  int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    perror(argv[1]);
    return 1;
  }
  check(seccomp_export_bpf(ctx, fd), "export");
  close(fd);
  seccomp_release(ctx);
  return 0;
}
