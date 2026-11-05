import type { FileHandle } from 'node:fs/promises';
import { VIDEO_LIMITS, type VideoParameters } from '../../shared/video.js';
import { VideoError } from './errors.js';

interface Box {type:string; start:number; body:number; end:number}
interface Track {kind:string; duration:number; width:number; height:number; ranges:Array<[number,number]>}
const invalid = (): never => { throw new VideoError('output_invalid',422); };
const safe = (n: bigint): number => n > BigInt(Number.MAX_SAFE_INTEGER) ? invalid() : Number(n);
const u32 = (b:Buffer,p:number): number => p < 0 || p+4 > b.length ? invalid() : b.readUInt32BE(p);
const u64 = (b:Buffer,p:number): number => p < 0 || p+8 > b.length ? invalid() : safe(b.readBigUInt64BE(p));
const u16 = (b:Buffer,p:number): number => p < 0 || p+2 > b.length ? invalid() : b.readUInt16BE(p);

/** Structural H.264/AAC ISO-BMFF validation, not a decoder. No mdat payload is loaded. */
export async function inspectMp4(fd: FileHandle, size:number, request:VideoParameters): Promise<{durationMs:number;width:number;height:number;hasAudio:boolean}> {
  try { return await inspect(fd,size,request); } catch { return invalid(); }
}
async function inspect(fd:FileHandle,size:number,request:VideoParameters) {
  const stat = await fd.stat();
  if (!stat.isFile() || !Number.isSafeInteger(size) || size <= 0 || size > VIDEO_LIMITS.outputBytes || stat.size !== size) invalid();
  let boxCount = 0;
  let metadata = 0;
  async function read(position:number,length:number):Promise<Buffer> {
    if (!Number.isSafeInteger(position+length) || position < 0 || length < 0 || position+length > size || length > VIDEO_LIMITS.maxMetadataBytes) invalid();
    const b = Buffer.alloc(length);
    let n = 0;
    while (n < length) { const r = await fd.read(b,n,length-n,position+n); if (!r.bytesRead) invalid(); n += r.bytesRead; }
    return b;
  }
  function boxes(b:Buffer,start=0,end=b.length,depth=0):Box[] {
    if (depth > 8) invalid();
    const result:Box[] = [];
    while (start < end) {
      if (++boxCount > VIDEO_LIMITS.maxBoxes || end-start < 8) invalid();
      const length = u32(b,start);
      const header = length === 1 ? 16 : 8;
      const actual = length === 1 ? u64(b,start+8) : length;
      if (actual < header || start+actual > end) invalid();
      result.push({type:b.toString('latin1',start+4,start+8),start,body:start+header,end:start+actual});
      start += actual;
    }
    return result;
  }
  const roots:Array<{type:string; body:number; end:number}> = [];
  const mdats:Array<[number,number]> = [];
  let pos = 0;
  while (pos < size) {
    if (++boxCount > VIDEO_LIMITS.maxBoxes || size-pos < 8) invalid();
    const h = await read(pos,Math.min(16,size-pos));
    const length = u32(h,0);
    const header = length === 1 ? 16 : 8;
    const actual = length === 1 ? u64(h,8) : length;
    if (actual < header || pos+actual > size) invalid();
    const type = h.toString('latin1',4,8);
    if (!['ftyp','free','skip','wide','moov','mdat'].includes(type)) invalid();
    roots.push({type,body:pos+header,end:pos+actual});
    if (type === 'mdat') mdats.push([pos+header,pos+actual]);
    else { metadata += actual; if (metadata > VIDEO_LIMITS.maxMetadataBytes) invalid(); }
    pos += actual;
  }
  const ftypes = roots.filter(b => b.type === 'ftyp');
  const movies = roots.filter(b => b.type === 'moov');
  if (ftypes.length !== 1 || movies.length !== 1 || !mdats.length || roots[0]?.type !== 'ftyp') invalid();
  const f = ftypes[0]!;
  const brand = await read(f.body,f.end-f.body);
  if (brand.length < 8 || brand.length % 4) invalid();
  const brands = [brand.toString('latin1',0,4)];
  for (let i=8;i<brand.length;i+=4) brands.push(brand.toString('latin1',i,i+4));
  if (!brands.some(b => ['isom','iso2','mp41','mp42','avc1'].includes(b)) || brands.some(b => ['avif','avis','heic','heix','mif1','msf1','qt  '].includes(b))) invalid();
  const movie = movies[0]!;
  const b = await read(movie.body,movie.end-movie.body);
  const tree = new Map<Box,Box[]>();
  const containers = new Set(['trak','mdia','minf','stbl','dinf','edts','udta','meta']);
  function walk(start:number,end:number,depth:number):Box[] {
    const list = boxes(b,start,end,depth);
    for (const box of list) {
      if (['moof','sinf','schm','schi','encv','enca'].includes(box.type)) invalid();
      if (containers.has(box.type)) tree.set(box,walk(box.body+(box.type === 'meta' ? 4:0),box.end,depth+1));
    }
    return list;
  }
  const top = walk(0,b.length,1);
  const children = (box:Box) => tree.get(box) ?? invalid();
  function one(list:Box[],type:string):Box {
    const found = list.filter(x => x.type === type);
    if (found.length !== 1) invalid();
    return found[0]!;
  }
  const data = (box:Box) => b.subarray(box.body,box.end);
  function full(box:Box,version=0):Buffer {
    const d = data(box);
    if (d.length < 4 || d[0] !== version || d[1] || d[2] || d[3]) invalid();
    return d;
  }
  function timing(box:Box):number {
    const d = data(box); const v = d[0];
    if (d.length < 4 || (v !== 0 && v !== 1) || d[1] || d[2] || d[3]) invalid();
    const scale = u32(d,v === 1 ? 20:12);
    const ticks = v === 1 ? u64(d,24):u32(d,16);
    const seconds = ticks/scale;
    if (!scale || !Number.isFinite(seconds) || seconds <= 0 || seconds > 8.5) invalid();
    return seconds;
  }
  const movieDuration = timing(one(top,'mvhd'));
  if (Math.abs(movieDuration-request.durationSeconds) > .5) invalid();
  function table(box:Box,width:number):Buffer {
    const d = full(box); const count = u32(d,4);
    if (count > VIDEO_LIMITS.maxTableEntries || d.length !== 8+count*width) invalid();
    return d;
  }
  function track(box:Box):Track {
    const list = children(box);
    const tk = data(one(list,'tkhd'));
    const v = tk[0];
    if (v !== 0 && v !== 1 || tk.length !== (v === 1 ? 96:84) || !(u32(tk,0)&1)) invalid();
    const matrix = v === 1 ? 52:40;
    const identity = [65536,0,0,0,65536,0,0,0,1073741824];
    identity.forEach((n,i) => {if (u32(tk,matrix+i*4) !== n) invalid();});
    const width = u32(tk,matrix+36)/65536, height = u32(tk,matrix+40)/65536;
    const mdia = children(one(list,'mdia'));
    const duration = timing(one(mdia,'mdhd'));
    if (Math.abs(duration-movieDuration) > .5 || Math.abs(duration-request.durationSeconds) > .5) invalid();
    const movieHeader = data(one(top,'mvhd'));
    const movieScale = u32(movieHeader,movieHeader[0] === 1 ? 20:12);
    const trackTicks = v === 1 ? u64(tk,28):u32(tk,20);
    if (!trackTicks || Math.abs(trackTicks/movieScale-duration) > .5) invalid();
    const hd = full(one(mdia,'hdlr'));
    const kind = hd.toString('latin1',8,12);
    if (kind !== 'vide' && kind !== 'soun') invalid();
    const minf = children(one(mdia,'minf'));
    const dinf = children(one(minf,'dinf'));
    const dr = full(one(dinf,'dref'));
    if (u32(dr,4) !== 1) invalid();
    const refs = boxes(dr,8);
    if (refs.length !== 1 || refs[0]!.type !== 'url ' || refs[0]!.end-refs[0]!.body !== 4 || u32(dr,refs[0]!.body) !== 1) invalid();
    const stbl = children(one(minf,'stbl'));
    const sd = full(one(stbl,'stsd'));
    if (u32(sd,4) !== 1) invalid();
    const entries = boxes(sd,8);
    if (entries.length !== 1) invalid();
    const entry = entries[0]!;
    if (u16(sd,entry.body+6) !== 1) invalid();
    const ranges:Array<[number,number]> = [];
    if (kind === 'vide') {
      if (entry.type !== 'avc1' || entry.end-entry.start < 86 || width !== u16(sd,entry.start+32) || height !== u16(sd,entry.start+34)) invalid();
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 1920 || height > 1920 || width*height > 2073600) invalid();
      const expected = request.size === '720p' ? [1280,720]:[1920,1080];
      if (request.aspectRatio === '9:16') expected.reverse();
      if (Math.abs(width-expected[0]!) > 16 || Math.abs(height-expected[1]!) > 16) invalid();
      const ext = boxes(sd,entry.start+86,entry.end);
      if (ext.some(x => !['avcC','btrt','pasp','colr','clap'].includes(x.type))) invalid();
      const avc = one(ext,'avcC'); const config = sd.subarray(avc.body,avc.end);
      if (config.length < 7 || config.length > 65536 || config[0] !== 1 || (config[4]! & 3) !== 3) invalid();
      let off = 6; const sps = config[5]! & 31;
      if (!sps) invalid();
      for (let i=0;i<sps;i++) {const len=u16(config,off);off+=2;if (!len || off+len > config.length) invalid(); off+=len;}
      if (off >= config.length) invalid();
      const pps = config[off++]!; if (!pps) invalid();
      for (let i=0;i<pps;i++) {const len=u16(config,off);off+=2;if (!len || off+len > config.length) invalid();off+=len;}
      if (off > config.length) invalid();
    } else {
      if (entry.type !== 'mp4a' || entry.end-entry.start < 36 || u16(sd,entry.start+16) !== 0) invalid();
      const ext=boxes(sd,entry.start+36,entry.end);
      if (ext.some(x => !['esds','btrt'].includes(x.type))) invalid();
      const esds=one(ext,'esds');
      const d=sd.subarray(esds.body,esds.end);
      if (d.length < 8 || d.length > 65536 || u32(d,0) !== 0) invalid();
      function descriptor(start:number,end:number,tag:number) {
        if (d[start++] !== tag) invalid();
        let length=0, bytes=0, byte:number;
        do {if(start>=end || ++bytes>4) invalid();byte=d[start++]!;length=length*128+(byte&127);} while(byte&128);
        if(start+length>end) invalid();
        return {body:start,end:start+length};
      }
      const es=descriptor(4,d.length,3);
      if(es.body+3>es.end) invalid();
      const flags=d[es.body+2]!;
      // Optional URL/dependency fields are outside the curated self-contained subset.
      if(flags & 224) invalid();
      const dec=descriptor(es.body+3,es.end,4);
      if(dec.body+13>dec.end || d[dec.body]!==0x40 || (d[dec.body+1]!>>2)!==5) invalid();
      const asc=descriptor(dec.body+13,dec.end,5);
      if(asc.end-asc.body<2) invalid();
      const bits=u16(d,asc.body), objectType=bits>>11, frequency=(bits>>7)&15, channels=(bits>>3)&15;
      if(objectType!==2 || frequency>12 || channels<1 || channels>2) invalid();
    }
    const sz = full(one(stbl,'stsz'));
    const fixed = u32(sz,4), count = u32(sz,8);
    if (!count || count > (kind === 'vide' ? 500:10000) || sz.length !== 12+(fixed ? 0:count*4)) invalid();
    const sizes = Array.from({length:count},(_,i) => fixed || u32(sz,12+i*4));
    if (sizes.some(n => !n)) invalid();
    const ts = table(one(stbl,'stts'),8);
    let samples = 0, ticks = 0;
    for (let i=8;i<ts.length;i+=8) {const n=u32(ts,i), delta=u32(ts,i+4);if (!n || !delta) invalid();samples+=n;ticks+=n*delta;}
    const md = data(one(mdia,'mdhd')); const scale=u32(md,md[0] === 1 ? 20:12);
    if (samples !== count || !Number.isSafeInteger(ticks) || Math.abs(ticks/scale-duration) > .05 || kind === 'vide' && count/duration > 60) invalid();
    for (const opt of stbl.filter(x => x.type === 'ctts' || x.type === 'stss')) {
      const d = table(opt,opt.type === 'ctts' ? 8:4);
      if (opt.type === 'ctts') {let n=0;for(let i=8;i<d.length;i+=8){n+=u32(d,i);if(u32(d,i+4)/scale > 8.5) invalid();}if(n !== count) invalid();}
      else {let prev=0;for(let i=8;i<d.length;i+=4){const n=u32(d,i);if(n<=prev || n>count) invalid();prev=n;}}
    }
    const offsets = stbl.filter(x => x.type === 'stco' || x.type === 'co64');
    if (offsets.length !== 1) invalid();
    const wide=offsets[0]!.type === 'co64';const co=table(offsets[0]!,wide ? 8:4);
    const chunks=Array.from({length:u32(co,4)},(_,i)=>wide ? u64(co,8+i*8):u32(co,8+i*4));
    const sc=table(one(stbl,'stsc'),12);
    const mappings:Array<{first:number;n:number}>=[];
    for(let i=8;i<sc.length;i+=12){const first=u32(sc,i),n=u32(sc,i+4);if(!n || first<1 || first>chunks.length || first<=(mappings.at(-1)?.first ?? 0) || u32(sc,i+8)!==1) invalid();mappings.push({first,n});}
    if(mappings[0]?.first !== 1) invalid();
    let sample=0,map=0;
    chunks.forEach((start,i)=>{while(mappings[map+1] && mappings[map+1]!.first<=i+1) map++;let end=start;for(let j=0;j<mappings[map]!.n;j++){if(sample>=count) invalid();end+=sizes[sample++]!;}if(!Number.isSafeInteger(end) || !mdats.some(([a,z])=>start>=a && end<=z)) invalid();ranges.push([start,end]);});
    if(sample!==count) invalid();
    const edits=list.filter(x=>x.type==='edts');
    if(edits.length>1) invalid();
    if(edits.length){const d=full(one(children(edits[0]!),'elst'));if(u32(d,4)!==1 || d.length!==20 || d.readInt32BE(12)<0 || u32(d,16)!==65536) invalid();const mv=data(one(top,'mvhd'));const scale=u32(mv,mv[0]===1 ? 20:12);if(Math.abs(u32(d,8)/scale-duration)>.05 || d.readInt32BE(12)/u32(md,md[0]===1 ? 20:12)+u32(d,8)/scale>duration+.05) invalid();}
    return {kind,duration,width,height,ranges};
  }
  const tracks = top.filter(x=>x.type==='trak').map(track);
  const videos=tracks.filter(t=>t.kind==='vide'), audios=tracks.filter(t=>t.kind==='soun');
  if(videos.length!==1 || audios.length>1 || tracks.length>2) invalid();
  const ranges=tracks.flatMap(t=>t.ranges).sort((a,z)=>a[0]-z[0]);
  for(let i=1;i<ranges.length;i++) if(ranges[i]![0]<ranges[i-1]![1]) invalid();
  const video=videos[0]!;
  return {durationMs:Math.round(video.duration*1000),width:video.width,height:video.height,hasAudio:audios.length===1};
}
