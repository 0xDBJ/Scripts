//A  project by 0xDBJ
'use strict';

setTimeout(() => Java.perform(() => {
  console.log('[*] Instalando hooks HTTP(S) completos…');

  /////////////////////////////////
  // 1) Java-level hooks
  /////////////////////////////////

  // utilitário genérico para imprimir Map<String,?>
  function printMap(m) {
    try {
      m.entrySet().toArray().forEach(e => {
        const k = e.getKey(), v = e.getValue();
        if (Java.cast(v, Java.use('java.util.List'))) {
          v.toArray().forEach(item => console.log(`    ${k}: ${item}`));
        } else {
          console.log(`    ${k}: ${v}`);
        }
      });
    } catch (_) {}
  }

  // 1.1 HttpURLConnection (HTTP/1.x)
  try {
    const HC  = Java.use('java.net.HttpURLConnection');
    const Br  = Java.use('java.io.BufferedReader');
    const Isr = Java.use('java.io.InputStreamReader');

    HC.connect.implementation = function() {
      console.log(`\n>>> [HttpURLConnection] ${this.getRequestMethod()} ${this.getURL()}`);
      printMap(this.getRequestProperties());
      return this.connect();
    };
    HC.getOutputStream.overload().implementation = function() {
      const os     = this.getOutputStream();
      const method = this.getRequestMethod(), url = this.getURL().toString();
      const OS     = Java.use('java.io.OutputStream');
      OS.write.overload('[B','int','int').implementation = function(b,off,len) {
        const raw = Java.array('byte', b), sb = [];
        for (let i=0; i<len; i++) sb.push(String.fromCharCode(raw[off+i]&0xFF));
        console.log(`\n>>> [HttpURLConnection BODY ▶ ${method} ${url}]\n${sb.join('')}`);
        return this.write(b, off, len);
      };
      return os;
    };
    HC.getInputStream.overload().implementation = function() {
      const is = this.getInputStream();
      console.log(`\n<<< [HttpURLConnection] ${this.getResponseCode()} ${this.getResponseMessage()}`);
      printMap(this.getHeaderFields());
      try {
        const br = Br.$new(Isr.$new(is)), lines = [];
        let l;
        while ((l = br.readLine()) !== null) lines.push(l);
        console.log(lines.join('\n'));
      } catch(_) {}
      return is;
    };
    console.log('[*] Hooked HttpURLConnection');
  } catch(_) {}

  // 1.2 OkHttp “universal” via Interceptor.Chain.proceed
  try {
    const Chain = Java.use('okhttp3.Interceptor$Chain');
    Chain.proceed.overload('okhttp3.Request').implementation = function(req) {
      // log request
      console.log(`\n>>> [OkHttp] ${req.method()} ${req.url()}`);
      for (let i=0; i<req.headers().size(); i++) {
        console.log(`    ${req.headers().name(i)}: ${req.headers().value(i)}`);
      }
      try {
        const b = req.body();
        if (b) {
          const Buf = Java.use('okio.Buffer').$new();
          b.writeTo(Buf);
          console.log('    → BODY:\n' + Buf.readUtf8());
        }
      } catch(_) {}
      // proceed
      const resp = this.proceed(req);
      // log response
      console.log(`\n<<< [OkHttp] ${resp.code()} ${resp.message()}`);
      for (let i=0; i<resp.headers().size(); i++) {
        console.log(`    ${resp.headers().name(i)}: ${resp.headers().value(i)}`);
      }
      try {
        const peek = resp.peekBody(1024*1024);
        console.log('    ← BODY:\n' + peek.string());
      } catch(_) {}
      return resp;
    };
    console.log('[*] Hooked OkHttp Interceptor Chain');
  } catch(_) {}

  // 1.3 WebView
  try {
    const WV  = Java.use('android.webkit.WebView');
    const WVC = Java.use('android.webkit.WebViewClient');

    WV.loadUrl.overload('java.lang.String').implementation = function(u) {
      console.log(`\n[WebView] loadUrl → ${u}`);
      return this.loadUrl(u);
    };
    WV.loadUrl.overload('java.lang.String','java.util.Map').implementation = function(u,h) {
      console.log(`\n[WebView] loadUrl → ${u}`); printMap(h);
      return this.loadUrl(u,h);
    };
    WVC.shouldInterceptRequest
      .overload('android.webkit.WebView','android.webkit.WebResourceRequest')
      .implementation = function(v,req) {
        console.log(`\n[WebView] shouldInterceptRequest → ${req.getUrl()}`);
        try {
          const hh = req.getRequestHeaders();
          hh.keySet().toArray().forEach(k => console.log(`    ${k}: ${hh.get(k)}`));
        } catch(_) {}
        return this.shouldInterceptRequest(v,req);
      };
    console.log('[*] Hooked WebView');
  } catch(_) {}

  /////////////////////////////////
  // 2) Native-level TLS fallback (chunked + gzip)
  /////////////////////////////////
  const ntohs     = n => ((n & 0xff)<<8)|((n>>8)&0xff);
  const inet_ntoa = a => `${a&0xff}.${(a>>8)&0xff}.${(a>>16)&0xff}.${(a>>24)&0xff}`;

  const sockfdMap = {}, ipMap = {}, reqBufs = {}, resBufs = {}, hostMap = {}, seen = new Set();

  function concatAB(a,b){
    const u1=new Uint8Array(a), u2=new Uint8Array(b), o=new Uint8Array(u1.length+u2.length);
    o.set(u1,0); o.set(u2,u1.length); return o.buffer;
  }
  function ab2str(ab){
    const u=new Uint8Array(ab); let s=''; u.forEach(c=> s+=String.fromCharCode(c)); return s;
  }
  function decodeChunked(ab){
    const u=new Uint8Array(ab),chunks=[],n=u.length; let p=0;
    while(p<n){
      let hex=''; while(p<n&&u[p]!==13) hex+=String.fromCharCode(u[p++]);
      p+=2; const len=parseInt(hex.trim(),16); if(!len) break;
      chunks.push(u.slice(p,p+len)); p+=len+2;
    }
    const tot=chunks.reduce((s,c)=>s+c.length,0),out=new Uint8Array(tot); let off=0;
    chunks.forEach(c=>{ out.set(c,off); off+=c.length; });
    return out.buffer;
  }
  function decompressGzip(ab){
    const bytes=Array.from(new Uint8Array(ab)), jb=Java.array('byte',bytes),
          BAIS=Java.use('java.io.ByteArrayInputStream').$new(jb),
          GIS =Java.use('java.util.zip.GZIPInputStream').$new(BAIS),
          BAOS=Java.use('java.io.ByteArrayOutputStream').$new(),
          buf =Java.array('byte',new Array(1024).fill(0));
    let r; while((r=GIS.read(buf,0,buf.length))>0) BAOS.write(buf,0,r);
    return Java.use('java.lang.String').$new(BAOS.toByteArray(),'UTF-8');
  }

  function tryEmit(ab,sockfd,dir){
    const s=ab2str(ab),
          start=(()=>{
            const m=s.search(/^(?:GET|POST|PUT|DELETE|HEAD|OPTIONS) \//m);
            return m>=0?m:s.search(/^HTTP\/\d\.\d/m);
          })();
    if(start<0) return false;
    const sep=s.indexOf('\r\n\r\n',start); if(sep<0) return false;
    const hdr=s.slice(start,sep);
    let body=ab.slice(sep+4);
    if(/Transfer-Encoding:\s*chunked/i.test(hdr)) try{ body=decodeChunked(body);}catch(_){}
    if(dir==='REQ'){ const m=hdr.match(/^Host:\s*(.+)$/im); if(m) hostMap[sockfd]=m[1].trim(); }
    const host=hostMap[sockfd]||ipMap[sockfd]||'unknown',
          bs=ab2str(body).trim(), snippet=bs.slice(0,100),
          key=`${dir}@${host}::${hdr}::${snippet}`;
    if(seen.has(key)) return false; seen.add(key);
    console.log(`\n[${dir} @ ${host}]`); console.log(hdr);
    if(dir==='RES'&&/Content-Encoding:\s*gzip/i.test(hdr)){
      try{ console.log(decompressGzip(body)); }catch(e){console.log('[!] gzip failed',e);}
    } else if(bs) console.log(bs);
    return true;
  }

  // connect()
  try {
    const c = Module.findExportByName(null,'connect');
    Interceptor.attach(c,{onEnter(a){
      this.fd=a[0].toInt32(); const sa=a[1];
      if(Memory.readU16(sa)===2){
        const p=ntohs(Memory.readU16(sa.add(2))),
              ip=inet_ntoa(Memory.readU32(sa.add(4)));
        ipMap[this.fd]=`${ip}:${p}`;
      }
    }});
  } catch(_) {}

  // SSL_set_fd
  Process.enumerateModulesSync().forEach(m=>{
    try{
      const fn=Module.findExportByName(m.name,'SSL_set_fd');
      if(!fn) return;
      Interceptor.attach(fn,{onEnter(a){ sockfdMap[a[0].toString()]=a[1].toInt32(); }});
    }catch(_){}
  });

  // SSL_read / SSL_write
  function hook(m,fn){
    try{
      const p=Module.findExportByName(m,fn); if(!p) return;
      const isR=fn==='SSL_read';
      Interceptor.attach(p,{
        onEnter(a){ this.ssl=a[0].toString(); this.buf=a[1]; if(!isR) this.len=a[2].toInt32(); },
        onLeave(r){
          const L = isR? r.toInt32() : this.len;
          if(L<=0||L>65536) return;
          const fd=sockfdMap[this.ssl]||-1;
          let c; try{c=Memory.readByteArray(this.buf,L);}catch{return;}
          const store=isR?resBufs:reqBufs;
          store[fd]=store[fd]?concatAB(store[fd],c):c;
          if(tryEmit(store[fd],fd,isR?'RES':'REQ')) delete store[fd];
        }
      });
      console.log(`[*] Hooked ${fn} in ${m}`);
    } catch(_) {}
  }
  Process.enumerateModulesSync().forEach(m=>{ hook(m.name,'SSL_read'); hook(m.name,'SSL_write'); });

  console.log('[*] TODOS os hooks instalados.');
}), 0);
