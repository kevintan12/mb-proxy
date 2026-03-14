<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0a0f1e">
<title>MarketBrief</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#0a0f1e; --sur:#111827; --sur2:#1a2236; --bor:#1e2d45;
  --acc:#00d4ff; --grn:#10b981; --red:#ef4444;
  --txt:#e2e8f0; --mut:#64748b; --gld:#f59e0b; --orange:#f97316;
  --base:12px;
}
*{box-sizing:border-box;margin:0;padding:0;}
html{font-size:var(--base);}
html,body{height:100%;margin:0;}body{font-family:'DM Mono',monospace;background:var(--bg);color:var(--txt);font-size:1rem;}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
  background-image:linear-gradient(rgba(0,212,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,255,0.03) 1px,transparent 1px);
  background-size:40px 40px;}

.app{position:relative;z-index:1;margin:0 auto;display:flex;flex-direction:column;}

@media(min-width:769px){.app{max-width:1280px;height:100vh;overflow:hidden;display:flex;flex-direction:column;}.bnav{display:none;}.sidebar{display:flex;}.content{padding:0;flex:1;min-height:0;overflow-y:auto;}.hver{display:none;}}

.header{padding:10px 16px;border-bottom:1px solid var(--bor);display:flex;align-items:center;
  justify-content:space-between;gap:10px;position:sticky;top:0;background:rgba(10,15,30,0.96);
  backdrop-filter:blur(16px);z-index:100;}
.logo{font-family:'Syne',sans-serif;font-weight:800;font-size:1.5rem;color:var(--acc);white-space:nowrap;min-width:0;}
.logo span{color:var(--txt);}
.hdr-right{display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0;gap:1px;}.htime{font-size:0.78rem;color:var(--mut);text-align:right;white-space:nowrap;line-height:1.3;}.hver{font-family:'DM Mono',monospace;font-size:0.68rem;color:var(--mut);text-align:right;}.logo-ver{font-family:'DM Mono',monospace;font-size:0.7rem;font-weight:400;color:var(--mut);margin-left:8px;align-self:flex-end;padding-bottom:2px;}

.sidebar{flex-direction:column;gap:4px;padding:24px 16px;width:210px;flex-shrink:0;
  border-right:1px solid var(--bor);position:sticky;top:61px;height:calc(100vh - 61px);background:rgba(10,15,30,0.6);}
.sidebar-wrap{display:flex;flex:1;min-height:0;overflow:hidden;}
.sidebar-content{flex:1;overflow-y:auto;}
.snav-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;border:1px solid transparent;
  background:transparent;color:var(--mut);font-family:'DM Mono',monospace;font-size:1rem;cursor:pointer;transition:all 0.15s;width:100%;text-align:left;}
.snav-item.on{background:rgba(0,212,255,0.1);color:var(--acc);border-color:rgba(0,212,255,0.2);}
.snav-item:hover:not(.on){color:var(--txt);background:rgba(255,255,255,0.04);}
.snav-ico{font-size:1.1rem;}
.sidebar-logo{font-family:'Syne',sans-serif;font-weight:700;font-size:1.1rem;color:var(--acc);padding:0 14px 18px;border-bottom:1px solid var(--bor);margin-bottom:12px;}

.content{padding:16px 20px;}
@media(min-width:769px){.desktop-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:24px;height:100%;box-sizing:border-box;}.col-left{display:flex;flex-direction:column;min-height:0;}.col-right{display:flex;flex-direction:column;min-height:0;}}

.slabel{font-size:0.9rem;letter-spacing:0.12em;color:var(--mut);text-transform:uppercase;margin-bottom:10px;margin-top:22px;}
.slabel.notop{margin-top:0;}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--grn);margin-right:6px;animation:pulse 2s ease infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}

.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;}
.chip{padding:5px 14px;border-radius:20px;border:1px solid var(--bor);background:transparent;
  color:var(--mut);font-family:'DM Mono',monospace;font-size:1rem;cursor:pointer;transition:all 0.15s;}
.chip.on{background:var(--acc);border-color:var(--acc);color:var(--bg);font-weight:500;}
.chip:hover:not(.on){border-color:var(--acc);color:var(--acc);}

.card{background:var(--sur);border:1px solid var(--bor);border-radius:11px;padding:14px 16px;
  display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;gap:8px;
  transition:border-color 0.2s;animation:fu 0.32s ease both;}
.card:hover{border-color:var(--acc);}
@keyframes fu{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.card:nth-child(1){animation-delay:.04s}.card:nth-child(2){animation-delay:.08s}
.card:nth-child(3){animation-delay:.12s}.card:nth-child(4){animation-delay:.16s}
.card:nth-child(5){animation-delay:.20s}.card:nth-child(6){animation-delay:.24s}
.card:nth-child(7){animation-delay:.28s}.card:nth-child(8){animation-delay:.32s}
.cleft{display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0;overflow:hidden;}
.flag{width:34px;height:34px;border-radius:50%;background:var(--sur2);display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;}
.cname{font-family:'Syne',sans-serif;font-weight:700;font-size:1.1rem;line-height:1.35;word-break:break-word;}
.cbottom{display:none;}.csub{font-size:0.9rem;color:var(--mut);margin-top:2px;}.csym{margin-left:6px;color:var(--acc);font-size:0.8rem;opacity:0.75;}
.cright{text-align:right;flex-shrink:0;min-width:120px;}
.cprice{font-family:'Syne',sans-serif;font-weight:700;font-size:1.15rem;}
.cchg{font-size:0.95rem;margin-top:2px;}
.up{color:var(--grn);}.dn{color:var(--red);}.neu{color:var(--mut);}

.msg{background:var(--sur);border:1px solid var(--bor);border-radius:9px;padding:14px 16px;font-size:1rem;color:var(--mut);line-height:1.7;margin-bottom:8px;}
.idx-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;border-radius:11px;scrollbar-width:thin;scrollbar-color:var(--bor) transparent;}
.idx-scroll::-webkit-scrollbar{width:4px;}

.idx-scroll::-webkit-scrollbar-track{background:transparent;}
.idx-scroll::-webkit-scrollbar-thumb{background:var(--bor);border-radius:4px;}
.msg.err{border-color:var(--red);color:var(--red);}
.msg.ok{border-color:var(--grn);color:var(--grn);}
.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--bor);border-top-color:var(--acc);border-radius:50%;animation:sp 0.7s linear infinite;vertical-align:middle;}
@keyframes sp{to{transform:rotate(360deg)}}

.sumbox{background:linear-gradient(135deg,rgba(0,212,255,0.06),rgba(124,58,237,0.06));
  border:1px solid rgba(0,212,255,0.18);border-radius:13px;padding:18px;animation:fu 0.4s ease both;}
.sumhdr{display:flex;align-items:center;gap:8px;margin-bottom:13px;}
.badge{font-size:0.9rem;letter-spacing:0.08em;background:var(--acc);color:var(--bg);padding:3px 9px;border-radius:20px;font-weight:500;}
.sumdate{font-size:0.9rem;color:var(--mut);}

.ai-btn{width:100%;padding:12px;background:linear-gradient(135deg,rgba(0,212,255,0.15),rgba(124,58,237,0.15));
  border:1px solid rgba(0,212,255,0.35);border-radius:10px;color:var(--acc);
  font-family:'Syne',sans-serif;font-weight:700;font-size:1rem;cursor:pointer;
  transition:all 0.2s;margin-bottom:10px;display:flex;align-items:center;justify-content:center;gap:8px;}
.ai-btn:hover{background:linear-gradient(135deg,rgba(0,212,255,0.25),rgba(124,58,237,0.25));border-color:var(--acc);}
.ai-btn:disabled{opacity:0.4;cursor:not-allowed;}

.rfrow{display:flex;justify-content:flex-end;margin-bottom:8px;}
.rfbtn{background:none;border:1px solid var(--bor);color:var(--mut);border-radius:6px;padding:4px 11px;font-size:1rem;cursor:pointer;font-family:'DM Mono',monospace;transition:all 0.2s;}
.rfbtn:hover{border-color:var(--acc);color:var(--acc);}

/* ── Autocomplete search ── */
.ac-wrap{position:relative;margin-bottom:8px;}
.ac-input{width:100%;background:var(--sur);border:1px solid var(--bor);border-radius:9px;
  padding:11px 14px 11px 38px;color:var(--txt);font-family:'DM Mono',monospace;font-size:1rem;outline:none;transition:border-color 0.2s;}
.ac-input:focus{border-color:var(--acc);}
.ac-input::placeholder{color:var(--mut);}
.ac-icon{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--mut);font-size:1.1rem;pointer-events:none;}
.ac-spinner{position:absolute;right:13px;top:50%;transform:translateY(-50%);}
.ac-drop{position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--sur);
  border:1px solid var(--acc);border-radius:9px;z-index:200;overflow:hidden;
  box-shadow:0 8px 32px rgba(0,0,0,0.5);}
.ac-item{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;
  cursor:pointer;transition:background 0.12s;border-bottom:1px solid var(--bor);}
.ac-item:last-child{border-bottom:none;}
.ac-item:hover,.ac-item.sel{background:rgba(0,212,255,0.1);}
.ac-sym{font-family:'Syne',sans-serif;font-weight:700;font-size:1rem;color:var(--acc);}
.ac-name{font-size:0.9rem;color:var(--mut);margin-top:2px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-exch{font-size:0.85rem;color:var(--mut);text-align:right;white-space:nowrap;margin-left:8px;}
.ac-none{padding:12px 14px;font-size:0.9rem;color:var(--mut);text-align:center;}

.sbtn{width:100%;padding:11px;background:var(--acc);border:none;border-radius:8px;
  color:var(--bg);font-family:'Syne',sans-serif;font-weight:700;font-size:1rem;cursor:pointer;transition:opacity 0.2s;margin-bottom:14px;}
.sbtn:hover{opacity:0.85;}.sbtn:disabled{opacity:0.4;cursor:not-allowed;}

/* ── AI analysis button in search results ── */
.analyze-btn{width:100%;padding:10px;background:linear-gradient(135deg,rgba(0,212,255,0.12),rgba(124,58,237,0.12));
  border:1px solid rgba(0,212,255,0.3);border-radius:8px;color:var(--acc);
  font-family:'Syne',sans-serif;font-weight:700;font-size:0.95rem;cursor:pointer;
  transition:all 0.2s;margin-top:10px;display:flex;align-items:center;justify-content:center;gap:7px;}
.analyze-btn:hover{border-color:var(--acc);background:linear-gradient(135deg,rgba(0,212,255,0.2),rgba(124,58,237,0.2));}

.tcard{background:var(--sur);border:1px solid var(--bor);border-radius:13px;padding:16px;margin-bottom:10px;animation:fu 0.32s ease both;}
.ttop{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;}
.tsym{font-family:'Syne',sans-serif;font-weight:800;font-size:1.4rem;color:var(--acc);}
.tname{font-size:1rem;color:var(--mut);margin-top:3px;}
.tprice{font-family:'Syne',sans-serif;font-weight:700;font-size:1.5rem;text-align:right;}
.sgrid{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
.sstat{background:var(--sur2);border-radius:7px;padding:9px 11px;}
.ssl{font-size:0.85rem;color:var(--mut);letter-spacing:0.07em;text-transform:uppercase;}
.ssv{font-size:1rem;color:var(--txt);margin-top:3px;font-weight:500;}

.spanel{display:flex;flex-direction:column;gap:12px;}
.srow{background:var(--sur);border:1px solid var(--bor);border-radius:11px;padding:14px 16px;}
.slbl{font-size:0.9rem;color:var(--mut);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:9px;}
.sinp{width:100%;background:var(--sur2);border:1px solid var(--bor);border-radius:7px;padding:9px 11px;color:var(--txt);font-family:'DM Mono',monospace;font-size:1rem;outline:none;}
.sinp:focus{border-color:var(--acc);}
select.sinp{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:28px;}
.snote{font-size:0.9rem;color:var(--mut);margin-top:7px;line-height:1.6;}
.savebtn{width:100%;padding:12px;background:var(--acc);border:none;border-radius:9px;color:var(--bg);font-family:'Syne',sans-serif;font-weight:700;font-size:1rem;cursor:pointer;transition:opacity 0.2s;}
.savebtn:hover{opacity:0.85;}

.mkt-section{margin-bottom:16px;}
.mkt-section-title{font-size:0.85rem;color:var(--mut);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:6px;}
.ticker-tags{display:flex;flex-wrap:wrap;gap:6px;min-height:28px;}
.ttag{display:inline-flex;align-items:center;gap:5px;background:var(--sur2);border:1px solid var(--bor);border-radius:6px;padding:4px 9px;font-size:0.95rem;color:var(--txt);}
.ttag.fixed{border-color:rgba(0,212,255,0.3);color:var(--acc);}
.ttag .del{background:none;border:none;color:var(--red);cursor:pointer;font-size:1rem;padding:0;line-height:1;}
.ttag .mv{background:none;border:none;color:var(--mut);cursor:pointer;font-size:0.9rem;padding:0 2px;line-height:1;}
.ttag .mv:hover{color:var(--acc);}

/* Settings autocomplete add row */
.tadd-ac-wrap{position:relative;margin-top:8px;}
.tadd-ac-input{width:100%;background:var(--sur2);border:1px solid var(--bor);border-radius:7px;
  padding:8px 10px;color:var(--txt);font-family:'DM Mono',monospace;font-size:1rem;outline:none;}
.tadd-ac-input:focus{border-color:var(--acc);}
.tadd-ac-input::placeholder{color:var(--mut);}
.tadd-ac-drop{position:absolute;top:calc(100% + 3px);left:0;right:0;background:var(--sur);
  border:1px solid var(--acc);border-radius:8px;z-index:300;overflow:hidden;
  box-shadow:0 8px 24px rgba(0,0,0,0.5);}
.tadd-ac-item{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
  cursor:pointer;border-bottom:1px solid var(--bor);transition:background 0.12s;}
.tadd-ac-item:last-child{border-bottom:none;}
.tadd-ac-item:hover{background:rgba(0,212,255,0.1);}
.tadd-ac-sym{font-family:'Syne',sans-serif;font-weight:700;font-size:1rem;color:var(--acc);}
.tadd-ac-name{font-size:0.9rem;color:var(--mut);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;}
.tadd-ac-add{font-size:0.85rem;color:var(--grn);white-space:nowrap;margin-left:8px;font-weight:600;}

.bnav{position:fixed;bottom:0;left:0;right:0;width:100%;box-sizing:border-box;background:rgba(10,15,30,0.96);backdrop-filter:blur(20px);border-top:1px solid var(--bor);padding:7px 0 16px;z-index:100;overflow:hidden;}
.bitem{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:5px 0;cursor:pointer;border:none;background:transparent;color:var(--mut);font-family:'DM Mono',monospace;font-size:0.85rem;transition:color 0.2s;}
.bitem.on{color:var(--acc);}
.bico{font-size:1.1rem;}
.pwatip{margin:10px 20px 0;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:9px;padding:10px 13px;font-size:1rem;color:var(--gld);line-height:1.6;}

@media(max-width:768px){
  .app{max-width:480px;}
  .bnav{display:flex;}
  .sidebar{display:none;}
  .content{overflow-y:auto;padding-bottom:110px;}
  .logo{font-size:1.2rem;}
  .header{padding:8px 10px;}
  .logo-ver{display:none;}
  .idx-scroll{margin-bottom:0;}
  .ai-btn{position:sticky;bottom:68px;z-index:10;backdrop-filter:blur(10px);}
  .card{padding:10px 12px;flex-wrap:wrap;align-items:flex-start;}
  .flag{width:28px;height:28px;font-size:14px;flex-shrink:0;}
  .cleft{flex-basis:100%;gap:7px;}
  .cname{font-size:14px;overflow:visible;display:block;-webkit-line-clamp:unset;}
  .csub{font-size:13px;}
  .cright{flex-basis:100%;text-align:left;padding-left:35px;min-width:unset;margin-left:0;margin-top:2px;}
  .cprice{font-size:16px;}
  .cchg{font-size:13px;white-space:nowrap;}
}
</style>
</head>
<body>
<div id="pinOverlay" style="display:none;position:fixed;inset:0;background:#0a0f1e;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;">
  <div style="font-family:'Syne',sans-serif;font-weight:800;font-size:2rem;color:#00d4ff;">Market<span style="color:#e2e8f0;">Brief</span></div>
  <div style="font-size:1rem;color:#64748b;font-family:'DM Mono',monospace;">Enter PIN to continue</div>
  <div id="pinDots" style="display:flex;gap:12px;margin:8px 0;"><span class="pd" style="width:14px;height:14px;border-radius:50%;border:2px solid #1e2d45;background:transparent;display:inline-block;"></span><span class="pd" style="width:14px;height:14px;border-radius:50%;border:2px solid #1e2d45;background:transparent;display:inline-block;"></span><span class="pd" style="width:14px;height:14px;border-radius:50%;border:2px solid #1e2d45;background:transparent;display:inline-block;"></span><span class="pd" style="width:14px;height:14px;border-radius:50%;border:2px solid #1e2d45;background:transparent;display:inline-block;"></span><span class="pd" style="width:14px;height:14px;border-radius:50%;border:2px solid #1e2d45;background:transparent;display:inline-block;"></span><span class="pd" style="width:14px;height:14px;border-radius:50%;border:2px solid #1e2d45;background:transparent;display:inline-block;"></span></div>
  <div id="pinPad" style="display:grid;grid-template-columns:repeat(3,72px);gap:10px;">
    <button onclick="pinKey('1')" class="pk">1</button><button onclick="pinKey('2')" class="pk">2</button><button onclick="pinKey('3')" class="pk">3</button>
    <button onclick="pinKey('4')" class="pk">4</button><button onclick="pinKey('5')" class="pk">5</button><button onclick="pinKey('6')" class="pk">6</button>
    <button onclick="pinKey('7')" class="pk">7</button><button onclick="pinKey('8')" class="pk">8</button><button onclick="pinKey('9')" class="pk">9</button>
    <button onclick="pinKey('C')" class="pk" style="color:#ef4444;">&#x2715;</button><button onclick="pinKey('0')" class="pk">0</button><button onclick="pinKey('OK')" class="pk" style="color:#00d4ff;">&#x2713;</button>
  </div>
  <div id="pinErr" style="color:#ef4444;font-size:0.9rem;font-family:'DM Mono',monospace;min-height:20px;"></div>
</div>
<style>
.pk{width:72px;height:72px;border-radius:50%;border:1px solid #1e2d45;background:#111827;color:#e2e8f0;font-family:'Syne',sans-serif;font-size:1.4rem;cursor:pointer;transition:all 0.15s;}
.pk:hover{background:#1a2236;border-color:#00d4ff;color:#00d4ff;}
@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
.pin-shake{animation:shake 0.4s ease;}
</style>
<div class="app" id="app">

  <div class="header">
    <div class="logo">Market<span>Brief</span><span class="logo-ver">v1.315.01</span></div><div class="hdr-right"><div class="htime" id="hTime"></div><div class="hver">v1.315.01</div></div>
  </div>
  <div class="pwatip" id="pwaTip" style="display:none">📱 Tap browser menu → <strong>Add to Home Screen</strong></div>

  <!-- DESKTOP -->
  <div class="sidebar-wrap" id="desktopWrap" style="display:none">
    <div class="sidebar">
      
      <button class="snav-item on" id="sn-Dash"     onclick="showView('Dash')"><span class="snav-ico">◈</span> Dashboard</button>
      <button class="snav-item"    id="sn-Search"   onclick="showView('Search')"><span class="snav-ico">⌕</span> Search</button>
      <button class="snav-item"    id="sn-Settings" onclick="showView('Settings')"><span class="snav-ico">⚙</span> Settings</button>
    </div>
    <div class="sidebar-content" id="desktopContent"></div>
  </div>

  <!-- MOBILE -->
  <div id="mobileWrap">
    <div id="vDash" class="content">
      <div class="rfrow"><button class="rfbtn" onclick="loadDash()">↻ Refresh</button></div>
      <div class="chips" id="mktChips">
        <button class="chip on" onclick="setFilter('all',this)">All</button>
        <button class="chip" onclick="setFilter('US',this)">🇺🇸 US</button>
        <button class="chip" onclick="setFilter('SG',this)">🇸🇬 SGX</button>
        <button class="chip" onclick="setFilter('HK',this)">🇭🇰 HKEX</button>
      </div>
      <div class="slabel notop">Market Indices <span id="liveIndM" style="font-size:0.85rem;margin-left:6px"></span></div>
      <div class="idx-scroll" id="idxGrid"><div class="msg">Loading… <span class="spin"></span></div></div>
      <button class="ai-btn" id="aiBtnM" onclick="triggerSummary()">✦ Generate AI Summary</button>
      <div class="slabel"><span class="dot"></span>AI Summary</div>
      <div id="sumArea"></div>
    </div>

    <div id="vSearch" class="content" style="display:none">
      <div class="slabel notop">Search by Name or Ticker</div>
      <div id="searchBox"></div>
      <div id="tickRes"></div>
    </div>

    <div id="vSettings" class="content" style="display:none">
      <div class="slabel notop">Configuration</div>
      <div class="spanel" id="settingsPanel"></div>
    </div>
  </div>
</div>

<div class="bnav" id="mBnav">
  <button class="bitem on" id="bn-Dash"     onclick="showView('Dash')"><span class="bico">◈</span>Dashboard</button>
  <button class="bitem"    id="bn-Search"   onclick="showView('Search')"><span class="bico">⌕</span>Search</button>
  <button class="bitem"    id="bn-Settings" onclick="showView('Settings')"><span class="bico">⚙</span>Settings</button>
</div>

<script>
// ── PIN Protection ───────────────────────────────────────────────────────────
var _pinBuffer='';
var _defaultPinHash='8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92';
async function sha256(str){
  var buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
}
function getStoredPinHash(){
  try{return localStorage.getItem('mb_pin_hash')||_defaultPinHash;}catch(e){return _defaultPinHash;}
}
function pinKey(k){
  var err=document.getElementById('pinErr');
  if(err) err.textContent='';
  if(k==='C'){_pinBuffer=_pinBuffer.slice(0,-1);updatePinDots();return;}
  if(k==='OK'){checkPin();return;}
  if(_pinBuffer.length>=6) return;
  _pinBuffer+=k;
  updatePinDots();
  if(_pinBuffer.length===6) setTimeout(checkPin,80);
}
function updatePinDots(){
  var dots=document.querySelectorAll('.pd');
  dots.forEach(function(d,i){
    d.style.background=i<_pinBuffer.length?'#00d4ff':'transparent';
    d.style.borderColor=i<_pinBuffer.length?'#00d4ff':'#1e2d45';
  });
}
async function checkPin(){
  var hash=await sha256(_pinBuffer);
  if(hash===getStoredPinHash()){
    try{sessionStorage.setItem('mb_auth','1');}catch(e){}
    document.getElementById('pinOverlay').style.display='none';
  } else {
    _pinBuffer='';
    updatePinDots();
    var pad=document.getElementById('pinPad');
    var err=document.getElementById('pinErr');
    if(pad){pad.classList.add('pin-shake');setTimeout(function(){pad.classList.remove('pin-shake');},400);}
    if(err) err.textContent='Incorrect PIN';
  }
}
async function changePIN(current,newPin,confirm){
  if(newPin.length!==6) return 'PIN must be 6 digits';
  if(newPin!==confirm) return 'New PINs do not match';
  var currentHash=await sha256(current);
  if(currentHash!==getStoredPinHash()) return 'Current PIN incorrect';
  var newHash=await sha256(newPin);
  try{localStorage.setItem('mb_pin_hash',newHash);}catch(e){return 'Could not save PIN';}
  return 'ok';
}
function initPIN(){
  var authed=false;
  try{authed=sessionStorage.getItem('mb_auth')==='1';}catch(e){}
  if(!authed){
    document.getElementById('pinOverlay').style.display='flex';
    document.addEventListener('keydown',function(e){
      if(document.getElementById('pinOverlay').style.display==='none') return;
      if(e.key>='0'&&e.key<='9') pinKey(e.key);
      else if(e.key==='Backspace') pinKey('C');
      else if(e.key==='Enter') pinKey('OK');
    });
  }
}

// ── Version cache-bust ────────────────────────────────────────────────────────
(function(){
  var CURRENT='v1.315.01';
  try{
    var last=sessionStorage.getItem('mb_ver');
    if(last&&last!==CURRENT){sessionStorage.setItem('mb_ver',CURRENT);}
    else if(!last){sessionStorage.setItem('mb_ver',CURRENT);}
  }catch(e){}
  // Fetch the live page with no-cache to check if a newer version exists
  if('serviceWorker' in navigator) return; // skip if SW handles it
  fetch(location.href,{cache:'no-store',method:'HEAD'}).then(function(r){
    var ver=r.headers.get('x-app-version')||'';
    // GitHub Pages won't return custom headers, so instead we reload once per session
    // if the page was loaded from cache (performance.navigation.type===2 means back/forward)
  }).catch(function(){});
})();
// ── State ─────────────────────────────────────────────────────────────────────
var S = {
  proxyUrl:'', style:'detailed', tz:'Asia/Singapore',
  // DJI first, then IXIC, then GSPC for US order
  fixedTickers:[
    {sym:'^DJI',  name:'Dow Jones', sub:'US · DJIA',              flag:'🇺🇸', mkt:'US'},
    {sym:'^IXIC', name:'Nasdaq',    sub:'US · Composite',         flag:'🇺🇸', mkt:'US'},
    {sym:'^GSPC', name:'S&P 500',   sub:'US · NYSE/Nasdaq',       flag:'🇺🇸', mkt:'US'},
    {sym:'^STI',  name:'STI',       sub:'SG · Straits Times Idx', flag:'🇸🇬', mkt:'SG'},
    {sym:'^HSI',  name:'Hang Seng', sub:'HK · Hang Seng Idx',    flag:'🇭🇰', mkt:'HK'},
  ],
  customTickers:{
    US:[],
    SG:[{sym:'D05.SI',name:'DBS Group',sub:'SG · SGX',flag:'🇸🇬',mkt:'SG'},{sym:'O39.SI',name:'OCBC',sub:'SG · SGX',flag:'🇸🇬',mkt:'SG'}],
    HK:[{sym:'1398.HK',name:'ICBC',sub:'HK · HKEX',flag:'🇭🇰',mkt:'HK'}]
  }
};
var mktData=[], curFilter='all', isDesktop=false, currentView='Dash';
var FIXED_SYMS={'^DJI':1,'^IXIC':1,'^GSPC':1,'^STI':1,'^HSI':1};
var acTimers={};  // debounce timers keyed by input id

// ── Boot ──────────────────────────────────────────────────────────────────────
window.onload=function(){
  initPIN();
  loadSettings();
  detectLayout();
  window.addEventListener('resize',detectLayout);
  tickClock(); setInterval(tickClock,1000);
  renderSettingsPanelTo('settingsPanel');
  loadDash();
  startAutoRefresh();
  // Force fresh content check — reload if a newer version is deployed
  setTimeout(function(){
    fetch(location.href,{cache:'no-store'})
      .then(function(r){return r.text();})
      .then(function(html){
        var m=html.match(/class="logo-ver"[^>]*>(v[\d.]+)<\/span>/);
        if(m&&m[1]&&m[1]!=='v1.315.01'){
          console.log('New version '+m[1]+' available, reloading…');
          location.reload(true);
        }
      }).catch(function(){});
  }, 3000);
  // Event delegation for search result buttons
  document.addEventListener('click',function(e){
    var ab=e.target.closest('.analyze-btn:not(.about-btn)');
    if(ab&&ab.dataset.sym){triggerTickerAI(ab.dataset.sym,ab.dataset.res,ab);return;}
    var bb=e.target.closest('.about-btn');
    if(bb&&bb.dataset.sym){triggerAboutAI(bb.dataset.sym,bb.dataset.res,bb,bb.dataset.name||bb.dataset.sym);return;}
    var pb=e.target.closest('.pdf-btn');
    if(pb&&pb.dataset.export){exportToPDF(pb.dataset.export);return;}
  });
  var sa=window.navigator.standalone||window.matchMedia('(display-mode: standalone)').matches;
  if(!sa&&/android|iphone|ipad/i.test(navigator.userAgent))
    document.getElementById('pwaTip').style.display='block';
};

function detectLayout(){
  isDesktop=window.innerWidth>=769;
  document.getElementById('desktopWrap').style.display=isDesktop?'flex':'none';
  document.getElementById('mobileWrap').style.display=isDesktop?'none':'block';
  document.getElementById('mBnav').style.display=isDesktop?'none':'flex';
  if(isDesktop) renderDesktop();
}

function tickClock(){
  var tz=S.tz||'Asia/Singapore';
  var lbl={'Asia/Singapore':'SGT','Asia/Hong_Kong':'HKT','America/New_York':'ET','UTC':'UTC'}[tz]||'';
  var now=new Date();
  document.getElementById('hTime').innerHTML=
    now.toLocaleDateString('en-SG',{timeZone:tz,month:'short',day:'numeric'})
    +' &middot; '+now.toLocaleTimeString('en-SG',{timeZone:tz,hour:'2-digit',minute:'2-digit'})+' '+lbl;
}

// ── Navigation ────────────────────────────────────────────────────────────────
function showView(name){
  // Save search content BEFORE switching away
  if(currentView==='Search'){
    // Try mobile first, then desktop; normalize IDs to always use 'tickRes' base
    var _trM=document.getElementById('tickRes');
    var _trD=document.getElementById('tickResD');
    var _saved='';
    if(_trM&&_trM.innerHTML&&_trM.innerHTML.length>200) _saved=_trM.innerHTML;
    else if(_trD&&_trD.innerHTML&&_trD.innerHTML.length>200) _saved=_trD.innerHTML.replace(/_tickResD"/g,'_tickRes"').replace(/_tickResD'/g,"_tickRes'");
    if(_saved) savedSearchHTML=_saved;
    var _inp=document.getElementById('ac_searchBox')||document.getElementById('ac_searchBoxD');
    if(_inp&&_inp.value) savedSearchQuery=_inp.value;
  }
  currentView=name;
  if(isDesktop){
    ['Dash','Search','Settings'].forEach(function(v){
      var e=document.getElementById('sn-'+v);if(e)e.classList.toggle('on',v===name);
    });
    renderDesktop();
  } else {
    ['Dash','Search','Settings'].forEach(function(v){
      document.getElementById('v'+v).style.display=v===name?'':'none';
      document.getElementById('bn-'+v).classList.toggle('on',v===name);
    });
    if(name==='Search'){
      // Only render search box on first visit — after that the DOM is preserved
      var existingInp=document.getElementById('ac_searchBox');
      if(!existingInp) renderSearchBox('searchBox','tickRes');
    }
    if(name==='Settings') renderSettingsPanelTo('settingsPanel');
    if(name==='Dash') {
      renderIndices(); updateLiveIndicator();
      // Restore active chip highlight
      document.querySelectorAll('#mktChips .chip').forEach(function(b){
        b.classList.toggle('on', b.textContent.trim().replace(/[^A-Za-z]/g,'').toLowerCase()===(curFilter==='all'?'all':curFilter.toLowerCase())||
          (curFilter==='all'&&b.textContent.trim()==='All'));
      });
      setTimeout(function(){var sa=document.getElementById('sumArea');if(sa&&savedSumHTML){sa.innerHTML=savedSumHTML;}},50);
    }
  }
}

function setFilter(f,btn){
  curFilter=f;
  document.querySelectorAll('#mktChips .chip').forEach(function(b){b.classList.remove('on');});
  btn.classList.add('on');
  clearTimeout(window._riTimer);
  window._riTimer=setTimeout(renderIndices,80);
}
function setFilterD(f,btn){
  curFilter=f;
  document.querySelectorAll('#mktChipsD .chip').forEach(function(b){b.classList.remove('on');});
  btn.classList.add('on');
  clearTimeout(window._riTimer);
  window._riTimer=setTimeout(renderIndices,80);
}

// ── Desktop ───────────────────────────────────────────────────────────────────
function renderDesktop(){
  var dc=document.getElementById('desktopContent'); if(!dc)return;
  if(currentView==='Dash'){
    dc.innerHTML=
      '<div class="desktop-grid">'
      +'<div class="col-left">'
        +'<div class="rfrow"><button class="rfbtn" onclick="loadDash()">↻ Refresh</button></div>'
        +'<div class="chips" id="mktChipsD">'
          +'<button class="chip on" onclick="setFilterD(\'all\',this)">All</button>'
          +'<button class="chip" onclick="setFilterD(\'US\',this)">🇺🇸 US</button>'
          +'<button class="chip" onclick="setFilterD(\'SG\',this)">🇸🇬 SGX</button>'
          +'<button class="chip" onclick="setFilterD(\'HK\',this)">🇭🇰 HKEX</button>'
        +'</div>'
        +'<div class="slabel notop">Market Indices <span id="liveIndD" style="font-size:0.85rem;margin-left:6px"></span></div>'
        +'<div class="idx-scroll" id="idxGridD"><div class="msg">Loading… <span class="spin"></span></div></div>'
      +'</div>'
      +'<div class="col-right">'
        +'<div class="slabel notop"><span class="dot"></span>AI Summary</div>'
        +'<button class="ai-btn" id="aiBtnD" onclick="triggerSummary()">✦ Generate AI Summary</button>'
        +'<div id="sumAreaD"></div>'
      +'</div>'
      +'</div>';
    renderIndices();
    setTimeout(updateLiveIndicator,50);
    // Restore active chip
    document.querySelectorAll('#mktChipsD .chip').forEach(function(b){
      var t=b.textContent.trim();
      b.classList.toggle('on',(curFilter==='all'&&t==='All')||(curFilter!=='all'&&t.indexOf(curFilter)!==-1));
    });
    window._tryRTimer=null;(function tryR(n){window._tryRTimer=setTimeout(function(){var sd=document.getElementById('sumAreaD');if(sd&&savedSumHTML){sd.innerHTML=savedSumHTML;}else if(n>0)tryR(n-1);},80);})(5);
  } else if(currentView==='Search'){
    // If we have a cached search DOM, restore it directly instead of re-rendering
    if(savedSearchHTML&&savedSearchQuery){
      dc.innerHTML='<div style="padding:24px;max-width:620px">'
        +'<div class="slabel notop">Search by Name or Ticker</div>'
        +'<div id="searchBoxD"></div><div id="tickResD"></div></div>';
      renderSearchBox('searchBoxD','tickResD');
      setTimeout(function(){
        var tr=document.getElementById('tickResD');
        // Normalize IDs: saved HTML may use 'tickRes' (mobile) or 'tickResD' (desktop)
        var html=savedSearchHTML.replace(/_tickRes"/g,'_tickResD"').replace(/_tickRes'/g,"_tickResD'");
        if(tr) tr.innerHTML=html;
        var inp=document.getElementById('ac_searchBoxD');
        if(inp) inp.value=savedSearchQuery;
      },30);
    } else {
      dc.innerHTML='<div style="padding:24px;max-width:620px">'
        +'<div class="slabel notop">Search by Name or Ticker</div>'
        +'<div id="searchBoxD"></div><div id="tickResD"></div></div>';
      renderSearchBox('searchBoxD','tickResD');
    }
  } else if(currentView==='Settings'){
    dc.innerHTML='<div style="padding:24px;max-width:720px"><div class="slabel notop">Configuration</div><div class="spanel" id="settingsPanelD"></div></div>';
    renderSettingsPanelTo('settingsPanelD');
  }
}

// ── Search Box with Autocomplete ──────────────────────────────────────────────
function renderSearchBox(boxId, resId){
  var el=document.getElementById(boxId); if(!el)return;
  var iid='ac_'+boxId;
  el.innerHTML=
    '<div class="ac-wrap" id="acWrap_'+boxId+'">'
      +'<span class="ac-icon">⌕</span>'
      +'<input class="ac-input" id="'+iid+'" placeholder="Type company name or ticker…" autocomplete="off" spellcheck="false">'
      +'<span class="ac-spinner" id="acSpin_'+boxId+'" style="display:none"><span class="spin"></span></span>'
    +'</div>'
    +'<button class="sbtn" id="sBtn_'+boxId+'" onclick="execSearch(\''+iid+'\',\'sBtn_'+boxId+'\',\''+resId+'\')" style="margin-top:8px">Search</button>';

  var inp=document.getElementById(iid);
  inp.addEventListener('input',function(){ acOnInput(this,boxId,resId); });
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter'){ closeAcDrop(boxId); execSearch(iid,'sBtn_'+boxId,resId); }
    if(e.key==='Escape') closeAcDrop(boxId);
  });
  document.addEventListener('click',function(e){
    var wrap=document.getElementById('acWrap_'+boxId);
    if(wrap&&!wrap.contains(e.target)) closeAcDrop(boxId);
  });
}

function acOnInput(inp,boxId,resId){
  var val=inp.value.trim();
  clearTimeout(acTimers[boxId]);
  if(val.length<2){ closeAcDrop(boxId); return; }
  acTimers[boxId]=setTimeout(function(){ acFetch(val,boxId,inp.id,resId); },320);
}

async function acFetch(q,boxId,inpId,resId){
  if(!S.proxyUrl) return;
  var spin=document.getElementById('acSpin_'+boxId);
  if(spin) spin.style.display='';
  try{
    var r=await fetch(S.proxyUrl+'/api/quote?search='+encodeURIComponent(q));
    var data=await r.json();
    var results=data.results||[];
    renderAcDrop(results,boxId,inpId,resId);
  }catch(e){ closeAcDrop(boxId); }
  if(spin) spin.style.display='none';
}

function renderAcDrop(results,boxId,inpId,resId){
  closeAcDrop(boxId);
  if(!results.length){
    var none=document.createElement('div');
    none.className='ac-drop'; none.id='acDrop_'+boxId;
    none.innerHTML='<div class="ac-none">No results found</div>';
    document.getElementById('acWrap_'+boxId).appendChild(none);
    return;
  }
  var html=results.map(function(r,i){
    return '<div class="ac-item" data-sym="'+esc(r.symbol)+'" data-name="'+esc(r.name)+'">'
      +'<div><div class="ac-sym">'+esc(r.symbol)+'</div><div class="ac-name">'+esc(r.name)+'</div></div>'
      +'<div class="ac-exch">'+esc(r.exchange||r.type||'')+'</div>'
      +'</div>';
  }).join('');
  var drop=document.createElement('div');
  drop.className='ac-drop'; drop.id='acDrop_'+boxId;
  drop.innerHTML=html;
  drop.querySelectorAll('.ac-item').forEach(function(item){
    item.addEventListener('click',function(){
      var sym=this.dataset.sym;
      var inp=document.getElementById(inpId);
      inp.value=sym;
      closeAcDrop(boxId);
      execSearch(inpId,'sBtn_'+boxId,resId);
    });
  });
  document.getElementById('acWrap_'+boxId).appendChild(drop);
}

function closeAcDrop(boxId){
  var d=document.getElementById('acDrop_'+boxId);
  if(d) d.remove();
}

async function execSearch(inpId,btnId,resId){
  var raw=document.getElementById(inpId).value.trim().toUpperCase();
  if(!raw)return;
  var btn=document.getElementById(btnId),res=document.getElementById(resId);
  btn.disabled=true; btn.textContent='Searching…';
  res.innerHTML='<div class="msg"><span class="spin"></span></div>';
  if(!S.proxyUrl){res.innerHTML='<div class="msg err">Add your Proxy URL in ⚙ Settings first.</div>';btn.disabled=false;btn.textContent='Search';return;}
  try{
    var d=await fetchQuote(raw);
    if(!d.price)throw new Error('No data for "'+raw+'"');
    lastSearchSym=raw;
    var cls=Math.abs(d.changePct)<0.01?'neu':(d.changePct>=0?'up':'dn');
    var arr=cls==='neu'?'—':(d.changePct>=0?'▲':'▼');
    var cardId='tc_'+resId;
    var tradingStatus=isTradingNow(raw);
    var statusBadge=tradingStatus
      ?'<span id="tradeBadge_'+resId+'" style="display:inline-flex;align-items:center;gap:4px;font-size:0.85rem;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);color:var(--grn);border-radius:20px;padding:2px 9px;margin-left:8px"><span class="dot" style="margin-right:0"></span>Trading</span>'
      :'<span id="tradeBadge_'+resId+'" style="display:inline-flex;align-items:center;font-size:0.85rem;background:rgba(100,116,139,0.15);border:1px solid var(--bor);color:var(--mut);border-radius:20px;padding:2px 9px;margin-left:8px">Closed</span>';
    res.innerHTML='<div class="tcard" id="'+cardId+'">'
      +'<div class="ttop"><div><div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px"><div class="tsym">'+esc(raw)+'</div>'+statusBadge+'</div><div class="tname">'+esc(d.name||raw)+'</div></div>'
      +'<div style="text-align:right"><div class="tprice '+cls+'" id="tprice_'+resId+'">'+fmt(d.price)+'</div>'
      +'<div class="cchg '+cls+'" id="tcchg_'+resId+'" style="text-align:right;margin-top:3px">'+arr+' '+fmtD(d.change)+' ('+fmtP(d.changePct)+')</div></div></div>'
      +'<div class="sgrid">'
      +'<div class="sstat"><div class="ssl">Volume</div><div class="ssv" id="tssv0_'+resId+'">'+fmtVol(d.volume)+'</div></div>'
      +'<div class="sstat"><div class="ssl">Prev Close</div><div class="ssv" id="tssv1_'+resId+'">'+fmt(d.prev)+'</div></div>'
      +'<div class="sstat"><div class="ssl">Day High</div><div class="ssv" id="tssv2_'+resId+'">'+fmt(d.high)+'</div></div>'
      +'<div class="sstat"><div class="ssl">Day Low</div><div class="ssv" id="tssv3_'+resId+'">'+fmt(d.low)+'</div></div>'
      +'</div>'
      +'</div>'
      '<div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;">'
        +'<button class="analyze-btn" id="anBtn_'+resId+'" data-sym="'+esc(raw)+'" data-res="'+resId+'">✦ Analyse with AI</button>'
        +'<button class="analyze-btn about-btn" style="background:rgba(100,116,139,0.12);border-color:rgba(100,116,139,0.3);color:var(--mut);" id="abBtn_'+resId+'" data-sym="'+esc(raw)+'" data-res="'+resId+'" data-name="'+esc(d.name)+'">ℹ About</button>'
        +'</div>'
      +'</div>'
      +'<div id="tai_'+resId+'"></div>';
  }catch(e){res.innerHTML='<div class="msg err">'+esc(e.message)+'</div>';}
  // Save search state for persistence across tab switches
  savedSearchQuery=raw;
  savedSearchHTML=res.innerHTML;
  btn.disabled=false; btn.textContent='Search';
}

function triggerTickerAI(sym,resId,btn){
  btn.style.display='none';
  // Restore about button
  var _abBtn=document.getElementById('abBtn_'+resId);
  if(_abBtn){_abBtn.disabled=false;_abBtn.textContent='ℹ About';}
  genTickerAI(sym,null,resId);
}

// ── AI button visibility ──────────────────────────────────────────────────────
function setAIBtnVisible(show){
  ['aiBtnM','aiBtnD'].forEach(function(id){
    var e=document.getElementById(id);
    if(e) e.style.display=show?'flex':'none';
  });
}
function triggerSummary(){
  if(!S.proxyUrl){setSumHTML('<div class="msg err">Add your Proxy URL in ⚙ Settings.</div>');return;}
  if(!mktData.length){setSumHTML('<div class="msg err">Load data first — click ↻ Refresh.</div>');return;}
  // Cancel any pending restore and clear old summary before generating fresh
  if(window._tryRTimer){clearTimeout(window._tryRTimer);window._tryRTimer=null;}
  savedSumHTML='';
  setSumHTML('');
  setAIBtnVisible(false);
  loadSummary();
}

// ── Data ──────────────────────────────────────────────────────────────────────
function getAllTickers(){
  var all=S.fixedTickers.slice();
  ['US','SG','HK'].forEach(function(m){all=all.concat(S.customTickers[m]||[]);});
  return all;
}
async function fetchQuote(sym){
  if(!S.proxyUrl)throw new Error('no_proxy');
  var r=await fetch(S.proxyUrl+'/api/quote?symbol='+encodeURIComponent(sym));
  if(!r.ok)throw new Error('HTTP '+r.status);
  var d=await r.json(); if(d.error)throw new Error(d.error);
  return d;
}
async function loadDash(){
  setGridHTML('<div class="msg">Loading… <span class="spin"></span></div>');
  setSumHTML(''); setAIBtnVisible(true);
  if(!S.proxyUrl){
    setGridHTML('<div class="msg">👋 Welcome! Go to <strong style="color:var(--txt)">⚙ Settings</strong> and enter your Proxy URL.</div>');
    return;
  }
  var tickers=getAllTickers();
  var results=await Promise.allSettled(tickers.map(function(t){return fetchQuote(t.sym);}));
  mktData=[];
  tickers.forEach(function(t,i){
    var r=results[i];
    if(r.status==='fulfilled'&&r.value&&r.value.price)
      mktData.push({sym:t.sym,name:r.value.name||t.name,sub:t.sub,flag:t.flag,mkt:t.mkt,price:r.value.price,chg:r.value.change,pct:r.value.changePct});
  });
  renderIndices();
  if(!mktData.length) setGridHTML('<div class="msg err">Could not load data. Check Proxy URL.</div>');
  startAutoRefresh();
}
function setGridHTML(h){var a=document.getElementById('idxGrid'),b=document.getElementById('idxGridD');if(a)a.innerHTML=h;if(b)b.innerHTML=h;}
function setSumHTML(h){var a=document.getElementById('sumArea'),b=document.getElementById('sumAreaD');if(a)a.innerHTML=h;if(b)b.innerHTML=h;}

// ── Real-time auto-refresh ────────────────────────────────────────────────────
var autoRefreshTimer=null;
var lastSearchSym=null;
var savedSumHTML='';
var savedSearchHTML='';
var savedSearchQuery='';

function isAnyMarketOpen(){
  var now=new Date(), day=now.getDay();
  function mins(tz){ var h=parseInt(now.toLocaleString('en-US',{timeZone:tz,hour:'numeric',hour12:false})),m=parseInt(now.toLocaleString('en-US',{timeZone:tz,minute:'numeric'})); return h*60+m; }
  var et=mins('America/New_York'), sg=mins('Asia/Singapore'), hk=mins('Asia/Hong_Kong');
  var wk=day>=1&&day<=5;
  return {
    any: wk&&((et>=570&&et<960)||(sg>=540&&sg<1020)||(hk>=570&&hk<960)),
    US:  wk&&et>=570&&et<960,
    SG:  wk&&sg>=540&&sg<1020,
    HK:  wk&&hk>=570&&hk<960
  };
}

function isTradingNow(sym){
  // Infer market from symbol suffix
  var s=isAnyMarketOpen();
  if(sym.endsWith('.SI')) return s.SG;
  if(sym.endsWith('.HK')) return s.HK;
  if(sym.startsWith('^')) {
    if(sym==='^STI') return s.SG;
    if(sym==='^HSI') return s.HK;
    return s.US;
  }
  return s.US; // default US for plain symbols like AAPL, ARM
}

function getOpenLabel(){
  var s=isAnyMarketOpen(), open=[];
  if(s.US)open.push('\u{1F1FA}\u{1F1F8}');
  if(s.SG)open.push('\u{1F1F8}\u{1F1EC}');
  if(s.HK)open.push('\u{1F1ED}\u{1F1F0}');
  return open.length?open.join(' ')+' LIVE':null;
}

async function silentRefreshDash(){
  if(!S.proxyUrl||!mktData.length)return;
  var s=isAnyMarketOpen();
  if(!s.any)return; // markets all closed — no fetching
  // Only fetch tickers whose market is currently open
  var tickers=getAllTickers().filter(function(t){return s[t.mkt];});
  if(!tickers.length)return;
  var results=await Promise.allSettled(tickers.map(function(t){return fetchQuote(t.sym);}));
  var updated=false;
  tickers.forEach(function(t,i){
    var r=results[i];
    if(r.status==='fulfilled'&&r.value&&r.value.price){
      var ex=mktData.find(function(x){return x.sym===t.sym;});
      if(ex){ex.price=r.value.price;ex.chg=r.value.change;ex.pct=r.value.changePct;updated=true;}
    }
  });
  if(updated)renderIndices();
  if(lastSearchSym&&isTradingNow(lastSearchSym))silentRefreshTicker(lastSearchSym);
  updateLiveIndicator();
}

async function silentRefreshTicker(sym){
  try{
    var d=await fetchQuote(sym);
    if(!d.price)return;
    ['tickRes','tickResD'].forEach(function(resId){
      var cls=Math.abs(d.changePct)<0.01?'neu':(d.changePct>=0?'up':'dn');
      var arr=cls==='neu'?'—':(d.changePct>=0?'▲':'▼');
      var pr=document.getElementById('tprice_'+resId);
      var chg=document.getElementById('tcchg_'+resId);
      if(pr){pr.className='tprice '+cls;pr.textContent=fmt(d.price);}
      if(chg){chg.className='cchg '+cls;chg.textContent=arr+' '+fmtD(d.change)+' ('+fmtP(d.changePct)+')';}
      var s0=document.getElementById('tssv0_'+resId);
      var s1=document.getElementById('tssv1_'+resId);
      var s2=document.getElementById('tssv2_'+resId);
      var s3=document.getElementById('tssv3_'+resId);
      if(s0){s0.className='ssv';s0.textContent=fmtVol(d.volume);}
      if(s1)s1.textContent=fmt(d.prev);
      if(s2)s2.textContent=fmt(d.high);
      if(s3)s3.textContent=fmt(d.low);
      // Update trading badge
      var badge=document.getElementById('tradeBadge_'+resId);
      if(badge){
        var trading=isTradingNow(sym);
        badge.style.background=trading?'rgba(16,185,129,0.15)':'rgba(100,116,139,0.15)';
        badge.style.borderColor=trading?'rgba(16,185,129,0.4)':'var(--bor)';
        badge.style.color=trading?'var(--grn)':'var(--mut)';
        badge.innerHTML=trading?'<span class="dot" style="margin-right:0"></span>Trading':'Closed';
      }
    });
  }catch(e){}
}

function updateLiveIndicator(){
  var s=isAnyMarketOpen();
  // Build label based on current filter
  var open=[];
  var mkts = curFilter==='all' ? ['US','SG','HK'] : [curFilter];
  mkts.forEach(function(m){ if(s[m]) open.push({US:'🇺🇸',SG:'🇸🇬',HK:'🇭🇰'}[m]); });
  var label=open.length ? open.join(' ')+' LIVE' : null;
  ['liveIndM','liveIndD'].forEach(function(id){
    var el=document.getElementById(id); if(!el)return;
    if(label){el.innerHTML='<span class="dot"></span>'+label;el.style.color='var(--grn)';}
    else{el.innerHTML='Market Closed';el.style.color='var(--mut)';}
  });
}

var _refreshTick=0, _refreshInFlight=false;
function startAutoRefresh(){
  if(autoRefreshTimer)clearInterval(autoRefreshTimer);
  _refreshTick=0;
  autoRefreshTimer=setInterval(function(){
    _refreshTick++;
    updateLiveIndicator();
    // Throttle actual fetches: every 5 ticks (5s) when market open, avoid concurrent fetches
    if(_refreshTick%5===0 && !_refreshInFlight && isAnyMarketOpen().any){
      _refreshInFlight=true;
      silentRefreshDash().finally(function(){_refreshInFlight=false;});
    }
    // Ticker refresh every 5s too
    if(_refreshTick%5===0 && lastSearchSym && isTradingNow(lastSearchSym) && !_refreshInFlight){
      silentRefreshTicker(lastSearchSym);
    }
  },1000);
  updateLiveIndicator();
}
function renderIndices(){
  var all=mktData;
  var filtered=curFilter==='all'?all:all.filter(function(d){return d.mkt===curFilter;});
  if(!filtered.length){setGridHTML('<div class="msg">No data for this filter.</div>');return;}
  // Sort order: US index, US watchlist, SG index, SG watchlist, HK index, HK watchlist
  var MKT_ORDER={US:0,SG:1,HK:2};
  var FIXED_SYMS={'^DJI':1,'^IXIC':1,'^GSPC':1,'^STI':1,'^HSI':1};
  function sortKey(d){
    var mo=MKT_ORDER[d.mkt]!=null?MKT_ORDER[d.mkt]:3;
    var isIdx=FIXED_SYMS[d.sym]?0:1;
    return mo*10+isIdx;
  }
  var sorted=filtered.slice().sort(function(a,b){return sortKey(a)-sortKey(b);});
  ['idxGrid','idxGridD'].forEach(function(gid){
    var g=document.getElementById(gid); if(!g)return;
    var existing=g.querySelectorAll('[data-sym]');
    if(existing.length!==sorted.length){
      // Full render with market group headers
      var html='';
      var lastGroup='';
      var groupLabels={US:'🇺🇸 US Markets',SG:'🇸🇬 Singapore Markets',HK:'🇭🇰 Hong Kong Markets'};
      var subLabels={idx:'Indices',watch:'Watchlist'};
      sorted.forEach(function(d){
        var isIdx=FIXED_SYMS[d.sym]?'idx':'watch';
        var grpKey=d.mkt+'-'+isIdx;
        if(grpKey!==lastGroup){
          lastGroup=grpKey;
          var grpLabel=(isIdx==='idx'?groupLabels[d.mkt]+' · Indices':groupLabels[d.mkt]+' · Watchlist');
          html+='<div style="font-size:0.78rem;letter-spacing:0.1em;color:var(--orange);text-transform:uppercase;padding:10px 4px 4px;border-top:'+(html?'1px solid rgba(249,115,22,0.2)':'none')+';">'+grpLabel+'</div>';
        }
        var cls=Math.abs(d.pct)<0.01?'neu':(d.pct>=0?'up':'dn');
        var arr=cls==='neu'?'—':(d.pct>=0?'▲':'▼');
        html+='<div class="card" data-sym="'+esc(d.sym)+'">'+
          '<div class="cleft"><div class="flag">'+d.flag+'</div>'+
          '<div style="min-width:0"><div class="cname">'+esc(d.name)+'</div>'+
          '<div class="csub">'+esc(d.sub)+'<span class="csym">'+esc(d.sym)+'</span></div></div></div>'+
          '<div class="cright"><div class="cprice '+cls+'" id="cp_'+gid+'_'+esc(d.sym)+'">'+fmt(d.price)+'</div>'+
          '<div class="cchg '+cls+'" id="cc_'+gid+'_'+esc(d.sym)+'">'+arr+' '+fmtD(d.chg)+' ('+fmtP(d.pct)+')</div></div>'+
          '</div>';
      });
      g.innerHTML=html;
      return;
    }
    // In-place update
    sorted.forEach(function(d){
      var cls=Math.abs(d.pct)<0.01?'neu':(d.pct>=0?'up':'dn');
      var arr=cls==='neu'?'—':(d.pct>=0?'▲':'▼');
      var pr=document.getElementById('cp_'+gid+'_'+d.sym);
      var ch=document.getElementById('cc_'+gid+'_'+d.sym);
      if(pr){pr.className='cprice '+cls;pr.textContent=fmt(d.price);}
      if(ch){ch.className='cchg '+cls;ch.textContent=arr+' '+fmtD(d.chg)+' ('+fmtP(d.pct)+')';}

    });
  });
}

// ── Closing date ──────────────────────────────────────────────────────────────
function getClosingDate(mkt){
  var tzMap={US:'America/New_York',SG:'Asia/Singapore',HK:'Asia/Hong_Kong'};
  var closeH={US:16,SG:17,HK:16}; // hour in market local time after which session is done
  var openH={US:9,SG:9,HK:9};
  var tz=tzMap[mkt]||'Asia/Singapore';
  var now=new Date();
  // Get current market-local time components
  var mktStr=now.toLocaleString('en-US',{timeZone:tz,hour:'numeric',minute:'numeric',hour12:false,year:'numeric',month:'numeric',day:'numeric',weekday:'long'});
  var mktNow=new Date(now.toLocaleString('en-US',{timeZone:tz}));
  var mktH=parseInt(now.toLocaleString('en-US',{timeZone:tz,hour:'numeric',hour12:false}));
  var mktDay=mktNow.getDay(); // 0=Sun,6=Sat
  var isWeekend=mktDay===0||mktDay===6;
  var sessionClosed=mktH>=closeH[mkt];
  // If today is a weekday and market has closed → today is the last session
  // If today is a weekday and market hasn't closed yet → last session = previous trading day
  // If weekend → last session = Friday
  var d=new Date(mktNow);
  if(!isWeekend&&sessionClosed){
    // today's session is complete — use today
  } else {
    // step back until we hit a weekday with a closed session
    d.setDate(d.getDate()-1);
    while(d.getDay()===0||d.getDay()===6) d.setDate(d.getDate()-1);
  }
  return d.toLocaleDateString('en-SG',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
}

// ── AI Summary ────────────────────────────────────────────────────────────────
async function loadSummary(){
  console.log('MB: loadSummary started');
  setSumHTML('<div class="msg">Generating AI summary… <span class="spin"></span></div>');
  var mktsToShow=curFilter==='all'?['US','SG','HK']:[curFilter];
  var styleInstr={
    detailed:'For each market section write 3-4 sentences. If the market is LIVE (session in progress), analyse what is happening RIGHT NOW in the current session — intraday moves, what is driving price action today, and what to watch for the rest of the session. If the market is closed, analyse the completed session. Cover: (1) what moved and by how much, (2) specific triggers or catalysts (macro data, Fed comments, earnings, geopolitical events, sector rotation), (3) notable individual movers, (4) near-term outlook. Be analytical, not just descriptive.',
    concise:'For each section write 2 sentences: first the key move with % change, second the main catalyst or driver. If LIVE, focus on current intraday action.',
    bullets:'Use 3-4 bullet points per section starting with -. First bullet = headline move, remaining bullets = specific catalysts and drivers. If LIVE, focus on what is happening now.'
  };
  var sections=[];
  var sectionLabels={US:'🇺🇸 US Markets',SG:'🇸🇬 Singapore Markets',HK:'🇭🇰 Hong Kong Markets'};
  var prompt='You are a financial analyst writing for a Singapore-based investor. The price and change data below is live-fetched from Yahoo Finance — treat it as accurate and current. Do NOT question the data or claim you lack real-time access. Search the web for today\'s market news and catalysts, then write your analysis directly. Be direct, use plain English and real numbers, explain the why behind every move.\n\n';
  var liveMarkets=isAnyMarketOpen();
  // Prepend live-search instruction if any watched market is open
  if(liveMarkets.any){
    var liveNames=[];
    if(liveMarkets.US&&mktsToShow.indexOf('US')!==-1) liveNames.push('US equities');
    if(liveMarkets.SG&&mktsToShow.indexOf('SG')!==-1) liveNames.push('Singapore (SGX)');
    if(liveMarkets.HK&&mktsToShow.indexOf('HK')!==-1) liveNames.push('Hong Kong (HKEX)');
    if(liveNames.length){
      prompt='LIVE SESSION IN PROGRESS for: '+liveNames.join(', ')+'.\n'
        +'Use web search to find the latest news and catalysts driving markets RIGHT NOW — '
        +'macro data releases today, central bank commentary, earnings, geopolitical events, sector moves. '
        +'Analyse the intraday price action in context of what you find. '
        +'Do NOT reference yesterday or the previous session for live markets — focus on what is happening today.\n\n'
        +prompt;
    }
  }
  // Further Reading instruction — placed early so searches happen before budget runs out
  prompt+=(function(){
    var _today=new Date();
    var _yy=_today.getFullYear();
    var _mm=String(_today.getMonth()+1).padStart(2,'0');
    var _dd=String(_today.getDate()).padStart(2,'0');
    var _ymd=_yy+'/'+_mm+'/'+_dd;
    var _dateStr=_yy+'-'+_mm+'-'+_dd;
    return 'IMPORTANT — 📰 Further Reading section instructions (do these searches now):\n'
      +'Search 1: Search "yahoo finance stock market today '+_dateStr+'" — find the finance.yahoo.com/news/live/stock-market-today-* article published on '+_dateStr+'. Do NOT use Motley Fool, Zacks or other sites.\n'
      +'Search 2: Search "cnbc stock market today '+_dateStr+'" — find the CNBC article URL from cnbc.com covering today stock market. The slug changes daily so always search, never guess.\n'
      +'Search 3: Search "site:minichart.com.sg market '+_dateStr+'" — find minichart.com.sg article published on '+_dateStr+'.\n'
      +'At the end output the 📰 Further Reading section, each as Label: URL on its own line:\n'
      +'Yahoo Finance Stock Market Today: [URL from Search 1, fallback: https://finance.yahoo.com/topic/stock-market-news/]\n'
      +'CNBC Daily Market Recap: [URL from Search 2, fallback: https://www.cnbc.com/markets/]\n'
      +'SGX Market Recap: [URL from Search 3, fallback: https://www.minichart.com.sg]\n'
      +'HK Market Daily: https://tradingeconomics.com/hong-kong/stock-market\n'
      +'You MUST output all 4 links. Use fallback if search found nothing.\n\n';
  })();
  mktsToShow.forEach(function(mkt){
    var d=mktData.filter(function(x){return x.mkt===mkt;});
    if(!d.length)return;
    var isLive=liveMarkets[mkt]||false;
    var now=new Date();
    var sgTime=now.toLocaleTimeString('en-SG',{timeZone:'Asia/Singapore',hour:'2-digit',minute:'2-digit'});
    var dateStr=isLive?'LIVE as of '+sgTime+' SGT':getClosingDate(mkt);
    var sessionCtx=isLive?'(session in progress — intraday data)':'(last close)';
    prompt+=sectionLabels[mkt]+' data '+sessionCtx+' '+dateStr+':\n'
      +d.map(function(x){return x.name+': '+fmt(x.price)+' '+fmtP(x.pct);}).join('\n')+'\n\n';
    sections.push({label:sectionLabels[mkt],date:dateStr,live:isLive});
  });
  // ── Watchlist data for prompt ──
  var watchTickers=mktData.filter(function(x){return !FIXED_SYMS[x.sym];});
  var watchLines='';
  if(watchTickers.length){
    watchLines='MY WATCHLIST DATA:\n';
    watchTickers.forEach(function(x){
      var arr=x.pct>=0?'▲':'▼';
      watchLines+=x.name+' ('+x.sym+'): '+fmt(x.price)+' '+arr+' '+fmtD(x.chg)+' ('+fmtP(x.pct)+')\n';
    });
    watchLines+='\n';
  }
  prompt+=watchLines;

  // ── Fetch regional indices ──
  var regionalSyms=['^KS11','^KLSE','^TWII','^N225'];
  var regionalNames={'^KS11':'KOSPI (South Korea)','^KLSE':'Bursa Malaysia (KLCI)','^TWII':'TAIEX (Taiwan)','^N225':'Nikkei 225 (Japan)'};
  var regionalLines='REGIONAL MARKETS DATA (fetched live):\n';
  console.log('MB: starting regional fetch');
  try{
    var regResults=await Promise.allSettled(regionalSyms.map(function(sym){return Promise.race([fetchQuote(sym),new Promise(function(_,rej){setTimeout(function(){rej(new Error('timeout'));},5000);})]);  }));
    regResults.forEach(function(r,i){
      var sym=regionalSyms[i];
      if(r.status==='fulfilled'&&r.value&&r.value.price!=null){
        var d=r.value;
        var arr=d.pct>=0?'▲':'▼';
        regionalLines+=regionalNames[sym]+': '+fmt(d.price)+' '+arr+' '+fmtD(d.chg)+' ('+fmtP(d.pct)+')\n';
      } else {
        regionalLines+=regionalNames[sym]+': data unavailable\n';
      }
    });
  } catch(e){
    regionalLines+='(regional data fetch failed)\n';
  }
  regionalLines+='\n';
  console.log('MB: regional fetch done');
  prompt+=regionalLines;

  var headerList=sections.map(function(s,i){return (i+1)+'. '+s.label+' ('+(s.live?'🔴 LIVE':''+s.date)+')';}).join('\n');
  var sectionCount=sections.length;
  if(mktsToShow.length>1) { headerList+='\n'+(++sectionCount)+'. 📊 Overall Sentiment'; }
  if(watchTickers.length)  { headerList+='\n'+(++sectionCount)+'. 💼 My Watchlist'; }
  headerList+='\n'+(++sectionCount)+'. 🌏 Regional Markets';
  prompt+='Write a structured market summary with EXACTLY these section headers (use them verbatim):\n'
    +headerList+'\n\n'+(styleInstr[S.style]||styleInstr.detailed)+'\n'
    +(mktsToShow.length>1?'End the Overall Sentiment section with one line e.g. "Sentiment: Cautiously Bullish".\n':'End with one line e.g. "Sentiment: Cautiously Bullish".\n')
    +'For each market, comment on volume relative to average — was volume elevated, light, or normal? High volume on a move suggests institutional conviction; low volume suggests retail-driven or unconvinced market. Distinguish where possible between institutional (block trades, futures-led, options activity) and retail (momentum-chasing, meme-driven) participation.\n'
    +'Focus on what matters for a Singapore investor.\n\n'
    +(watchTickers.length?'For the 💼 My Watchlist section: assess the overall sentiment of the watchlist (how many stocks are up vs down, breadth). Highlight the top 2-3 movers by % change — name them, give the % move, and one-line reason if identifiable. Keep to 3-4 sentences.\\n':'')
    +'For the 🌏 Regional Markets section: write one paragraph (3-4 sentences) summarising the KOSPI, Bursa Malaysia, TAIEX, and Nikkei using the data provided. Note overall direction, any standout market, and key drivers. Use web search if needed.\\n'

  var hdrHTML='<div class="sumbox"><div class="sumhdr" style="justify-content:space-between;"><div style="display:flex;align-items:center;gap:8px;"><span class="badge">AI · Claude</span>'
    +'<span class="sumdate" style="margin-left:4px">'+esc(mktsToShow.join(' + '))+' · '+new Date().toLocaleTimeString('en-SG',{timeZone:'Asia/Singapore',hour:'2-digit',minute:'2-digit'})+'</span></div><button class="pdf-btn" data-export="sum" style="background:none;border:1px solid var(--bor);color:var(--mut);border-radius:6px;padding:3px 10px;font-size:0.85rem;cursor:pointer;font-family:DM Mono,monospace;">PDF</button></div>'
    +'<div id="sumStream"><div class="msg">Searching &amp; analysing… <span id="cdNum">~20s</span></div></div></div>';
  setSumHTML(hdrHTML);
  // Find the VISIBLE sumStream — on desktop sumAreaD is shown, on mobile sumArea
  function getStreamEl(){
    var b=document.getElementById('sumAreaD'),a=document.getElementById('sumArea');
    var el=(b&&b.offsetParent!==null)?b.querySelector('#sumStream'):(a?a.querySelector('#sumStream'):null);
    return el||document.getElementById('sumStream');
  }
  var _cdSec=20,_cdFirstToken=false;
  window._sumCdTimer=setInterval(function(){
    _cdSec--;
    var n=document.getElementById('cdNum');
    if(n&&_cdSec>0) n.textContent='~'+_cdSec+'s';
    else if(_cdSec<=0) clearInterval(window._sumCdTimer);
  },1000);
  var accumulated='';
  try{
    console.log('MB: prompt built, length=',prompt.length);
    var resp=await fetch(S.proxyUrl+'/api/quote?claude=1',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:4000,stream:true,tools:[{type:'web_search_20250305',name:'web_search',max_uses:10}],messages:[{role:'user',content:prompt}]})
    });
    console.log('MB: API response status=',resp.status);
    if(!resp.ok){var e=await resp.json().catch(function(){return{};});throw new Error((e.error&&e.error.message)||'API error '+resp.status);}
    console.log('MB: reader loop starting');
    var reader=resp.body.getReader();
    var decoder=new TextDecoder();
    var buf='';
    while(true){
      var _r=await reader.read();
      if(_r.done)break;
      buf+=decoder.decode(_r.value,{stream:true});
      var lines=buf.split('\n');
      buf=lines.pop();
      for(var li=0;li<lines.length;li++){
        var line=lines[li].trim();
        if(!line.startsWith('data:'))continue;
        var json=line.slice(5).trim();
        if(json==='[DONE]')continue;
        try{
          var ev=JSON.parse(json);
          if(ev.type==='content_block_start'&&ev.content_block&&ev.content_block.type==='tool_use'){
            var _cdN=document.getElementById('cdNum');if(_cdN)_cdN.textContent='searching…';}
          if(ev.type==='content_block_delta'&&ev.delta&&ev.delta.type==='text_delta'){
            accumulated+=ev.delta.text;
            var sel=getStreamEl();
            if(!_cdFirstToken){_cdFirstToken=true;clearInterval(window._sumCdTimer);}
              if(sel){sel.innerHTML=formatSummary(cleanAIText(accumulated));
              // Update savedSumHTML - prefer whichever area has more content
              var _sa2a=document.getElementById('sumArea'),_sa2b=document.getElementById('sumAreaD');
              var _sa2=(_sa2b&&(_sa2b.innerHTML||'').length>(_sa2a&&_sa2a.innerHTML||'').length)?_sa2b:_sa2a;
              if(_sa2&&_sa2.innerHTML&&_sa2.innerHTML.length>100) savedSumHTML=_sa2.innerHTML;
            }
          }
        }catch(_){}
      }
    }
    // Final render
    var sel=getStreamEl();
    clearInterval(window._sumCdTimer);
    if(sel)sel.innerHTML=formatSummary(cleanAIText(accumulated));
    _sumInFlight=false;
    setAIBtnVisible(true);
    // Save complete rendered HTML for persistence across tab switches
    var _sa=document.getElementById('sumArea'); var _sb=document.getElementById('sumAreaD');
    var _saLen=(_sa&&_sa.innerHTML)?_sa.innerHTML.length:0;
    var _sbLen=(_sb&&_sb.innerHTML)?_sb.innerHTML.length:0;
    var _best=_sbLen>_saLen?_sb:_sa;
    if(_best&&_best.innerHTML&&_best.innerHTML.length>100) savedSumHTML=_best.innerHTML;
  }catch(e){
    setSumHTML('<div class="msg err">Summary error: '+esc(e.message)+'</div>');
    _sumInFlight=false;
    setAIBtnVisible(true);
  }
}

// ── Strip IV preamble ────────────────────────────────────────────
function stripIVPreamble(txt){
  var markers=['1. 💰','💰 Intrinsic','📈 Price Action','1. 📈'];
  var earliest=txt.length;
  for(var i=0;i<markers.length;i++){
    var pos=txt.indexOf(markers[i]);
    if(pos!==-1&&pos<earliest) earliest=pos;
  }
  // If marker not yet seen, return empty — suppresses preamble during streaming
  if(earliest===txt.length) return '';
  return txt.slice(earliest);
}

// ── Finnhub Intrinsic Value ──────────────────────────────────────────────────
async function fetchFinnhubValuation(sym, currentPrice){
  if(!S.proxyUrl) return null;
  if(sym.startsWith('^')) return null;
  try{
    var r=await fetch(S.proxyUrl+'/api/quote?finnhub=1&symbol='+encodeURIComponent(sym));
    if(!r.ok) throw new Error('HTTP '+r.status);
    var d=await r.json();
    if(!d.metric) throw new Error('No metric data');
    var m=d.metric;
    var eps   = m.epsBasicExclExtraItemsTTM||m.epsTTM||m.epsNormalizedAnnual||null;
    var fcfps = m.cashFlowPerShareTTM||m.cashFlowPerShareAnnual||null;
    var bvps  = m.bookValuePerShareAnnual||m.bookValuePerShareQuarterly||null;
    var pb    = m.pbAnnual||m.pbQuarterly||null;
    var growthRate=0.08;
    var g3=m.epsGrowth3Y||null, g5=m.epsGrowth5Y||null;
    // Finnhub returns growth as percentage (e.g. 12.24 = 12.24%), divide by 100
    if(g3&&g3>0) growthRate=Math.min(Math.max(g3/100,0.03),0.25);
    else if(g5&&g5>0) growthRate=Math.min(Math.max(g5/100,0.03),0.25);
    var disc=0.10, termG=0.03;
    function dcf20(e,g){
      if(!e||e<=0) return null;
      g=Math.min(g,0.15); // cap growth at 15% for conservatism
      var pv=0,ev=e;
      for(var yr=1;yr<=10;yr++){ev*=(1+g);pv+=ev/Math.pow(1+disc,yr);}
      var ev2=ev;
      for(var yr2=11;yr2<=20;yr2++){ev2*=(1+g/2);pv+=ev2/Math.pow(1+disc,yr2);}
      // Gordon Growth terminal value: more conservative than fixed P/E exit multiple
      var terminal=(ev2*(1+termG)/(disc-termG))/Math.pow(1+disc,20);
      return pv+terminal;
    }
    var dcf    = dcf20(eps, growthRate);
    var dfcf   = dcf20(fcfps, growthRate);
    var meanpb = (pb&&bvps&&pb>0&&bvps>0)?(pb*bvps):null;
    // Graham Formula: EPS x (8.5 + 2g) where g is growth rate as percentage
    var gPct   = growthRate*100;
    var graham = (eps&&eps>0)?(eps*(8.5+2*gPct)):null;
    // Graham Number: sqrt(22.5 x EPS x BVPS)
    var gnVal  = (eps&&eps>0&&bvps&&bvps>0)?(22.5*eps*bvps):null;
    var gnum   = (gnVal&&gnVal>0)?Math.sqrt(gnVal):null;
    var valid=[dcf,dfcf,meanpb,graham,gnum].filter(function(v){return v&&v>0;});
    if(!valid.length) return null;
    var mbVal=valid.reduce(function(a,b){return a+b;},0)/valid.length;
    var mos=currentPrice>0?((mbVal-currentPrice)/mbVal*100):null;
    var verdict=mos===null?'N/A':mos>20?'Undervalued':mos<-20?'Overvalued':'Fairly Valued';
    function f3(v){return v?'$'+v.toFixed(3):'N/A';}
    function fp(v){return v!==null?(v>=0?'+':'')+v.toFixed(1)+'%':'N/A';}
    return 'DCF-20: '+f3(dcf)+' | DFCF-20: '+f3(dfcf)+' | P/B Value: '+f3(meanpb)+'\n'
      +'Graham Formula: '+f3(graham)+' | Graham Number: '+f3(gnum)+'\n'
      +'MB Value: '+f3(mbVal)+' | Current Price: '+(currentPrice?fmt(currentPrice):'N/A')+' | Margin of Safety: '+fp(mos)+' | Verdict: '+verdict+'\n'
      +'_Generated with Finnhub data_';
  }catch(e){
    console.warn('Finnhub valuation failed:',e.message||e);
    return null;
  }
}


// ── Ticker AI (manual button) ─────────────────────────────────────────────────
async function genTickerAI(sym,d,resId){
  var el=document.getElementById('tai_'+resId);
  if(!el)return;
  var _tcdSec=15,_tcdFirst=false;
  el.innerHTML='<div class="msg">Analysing… <span id="tcdNum_'+resId+'">~'+_tcdSec+'s</span></div>';
  var _tcdTimer=setInterval(function(){
    _tcdSec--;
    var n=document.getElementById('tcdNum_'+resId);
    if(n&&_tcdSec>0) n.textContent='~'+_tcdSec+'s';
    else if(_tcdSec<=0) clearInterval(_tcdTimer);
  },1000);
  // Always fetch the freshest quote right now for accuracy
  var liveData=d;
  try{ liveData=await fetchQuote(sym); }catch(e){}
  var now=new Date();
  // Always use SGT for display date — this is a Singapore investor tool
  var dateStr=now.toLocaleDateString('en-SG',{timeZone:'Asia/Singapore',weekday:'long',year:'numeric',month:'long',day:'numeric'});
  var dayOfWeek=now.toLocaleDateString('en-US',{timeZone:'Asia/Singapore',weekday:'long'});
  // Determine prevDay label based on ticker's market
  function getPrevDay(sym){
    var tz='America/New_York';
    if(sym.endsWith('.SI')) tz='Asia/Singapore';
    else if(sym.endsWith('.HK')) tz='Asia/Hong_Kong';
    var openMin=tz==='Asia/Singapore'?540:570;
    var closeMin=tz==='Asia/Singapore'?1020:960;
    var now=new Date();
    var day=now.toLocaleDateString('en-US',{timeZone:tz,weekday:'long'});
    var h=parseInt(now.toLocaleString('en-US',{timeZone:tz,hour:'numeric',hour12:false}));
    var m=parseInt(now.toLocaleString('en-US',{timeZone:tz,minute:'numeric'}));
    var mins=h*60+m;
    var sessionOpen=mins>=openMin&&mins<closeMin;
    // Rules:
    // Weekend → Friday
    // Monday, session not yet open → Friday
    // Monday, session open or closed → Friday (prev session is always Friday)
    // Tuesday, session not yet open → Friday (Monday hasn't traded yet today, last close = Friday)
    // Tuesday, session open → Monday (trading against Monday's close)
    // Wed-Fri, session not yet open → yesterday (e.g. Wed before open → Tuesday)
    // Wed-Fri, session open or closed → yesterday
    if(day==='Saturday'||day==='Sunday') return 'Friday';
    if(day==='Monday') return 'Friday';
    if(day==='Tuesday'&&!sessionOpen) return 'Friday';
    if(day==='Tuesday'&&sessionOpen) return 'Monday';
    return 'yesterday';
  }
  var prevDay=getPrevDay(sym);
  var name=liveData&&liveData.name?liveData.name:sym;
  var yr=now.getFullYear();
  var priceBlock=liveData?
    'As of '+dateStr+':\n'
    +'  Price: '+fmt(liveData.price)+' '+(liveData.currency||'')+'\n'
    +'  Change from '+prevDay+"'s close ("+fmt(liveData.prev)+'): '+fmtD(liveData.change)+' ('+fmtP(liveData.changePct)+')\n'
    +'  Day High: '+fmt(liveData.high)+' / Day Low: '+fmt(liveData.low)+'\n'
    +'  Volume: '+fmtVol(liveData.volume)
    :'(no price data)';
  var mktTz=(sym.endsWith('.SI')?'Asia/Singapore':sym.endsWith('.HK')?'Asia/Hong_Kong':'America/New_York');
  var mktDateStr=now.toLocaleDateString('en-SG',{timeZone:mktTz,weekday:'long',year:'numeric',month:'long',day:'numeric'});
  // Fetch Finnhub valuation before building prompt
  var finnhubIV=null;
  try{ finnhubIV=await fetchFinnhubValuation(sym, liveData&&liveData.price?liveData.price:0); }catch(e){}

  // finnhubAttempted = Finnhub key set AND ticker is not an index
  var finnhubAttempted=S.proxyUrl&&!sym.startsWith('^');

  var ivSections=finnhubIV
    ? '2. 📈 Price Action\n3. 🔍 Key Drivers\n4. 📊 Volume & Participation\n5. ⚠️ Key Risks\n6. 🇸🇬 Singapore Investor Angle\n7. 🔮 Near-Term Outlook'
    : '1. 💰 Intrinsic Value\nTwo lines only (all monetary values to 3 decimal places e.g. $12.345):\nDCF-20: $X.XXX | DFCF-20: $X.XXX | Mean P/B: $X.XXX\nMB Value: $X.XXX | Current Price: '+(liveData&&liveData.price?fmt(liveData.price):'N/A')+' | Margin of Safety: X% | Verdict: Undervalued/Fairly Valued/Overvalued\n_Generated with search results_\n\n2. 📈 Price Action\n3. 🔍 Key Drivers\n4. 📊 Volume & Participation\n5. ⚠️ Key Risks\n6. 🇸🇬 Singapore Investor Angle\n7. 🔮 Near-Term Outlook';

  // If Yahoo was attempted but failed, do not fall back to AI — show unavailable instead
  var ivRule=finnhubIV?''
    :finnhubAttempted?''
    :'RULE: Always produce a best-effort valuation. Never refuse or list missing data. If exact figures are unavailable, use the best available estimate (e.g. trailing EPS, sector-average growth rate, or industry P/B). Mark estimated inputs with (est) inline. A rough estimate is more useful than no answer. NEVER show valuation inputs, working, or any intermediate data — output the two result lines only.\n\n'
    +'Use web search to fetch latest annual financials for '+sym+': EPS, FCF/share, BVPS, 5-yr avg P/B, analyst EPS growth rate. Compute silently, show NO working:\n'
    +'DCF-20: EPS x discounted growth (yrs 1-10 analyst rate, 11-20 half rate, 10% discount) + terminal (yr20 EPS x rate x 15 / 1.1^20).\n'
    +'DFCF-20: Same using FCF/share, 15x terminal.\n'
    +'Mean P/B: 5-yr avg P/B x BVPS.\n'
    +'MB Value: average of valid results only.\n\n';

  var prompt='You are a financial analyst covering '+sym+' ('+name+'). Today ('+mktDateStr+'), last session: '+prevDay+'. No title. No **bold**. No pre-'+yr+' events.\n\n'
    +ivRule
    +'Write EXACTLY these sections:\n'
    +ivSections+'\n\n'
    +'3-4 sentences per section. Use "'+prevDay+'" not "yesterday". For Near-Term Outlook make a direct call on likely direction over 5-10 trading days. End with: "Outlook: [one-line verdict]".';
  var finnhubIVHtml=finnhubIV?formatSummary('1. 💰 Intrinsic Value\n'+finnhubIV)
    :finnhubAttempted?formatSummary('1. 💰 Intrinsic Value\nIV data unavailable — could not retrieve Finnhub data for this ticker.\n_Generated with Finnhub data_'):
    '';
  var tickerHdrHTML='<div class="sumbox" style="margin-top:10px"><div class="sumhdr" style="justify-content:space-between;"><div style="display:flex;align-items:center;gap:8px;"><span class="badge">AI Analysis</span><span class="sumdate" style="margin-left:6px">'+esc(dateStr)+'</span></div><button class="pdf-btn" data-export="tick_'+resId+'" style="background:none;border:1px solid var(--bor);color:var(--mut);border-radius:6px;padding:3px 10px;font-size:0.85rem;cursor:pointer;font-family:DM Mono,monospace;">PDF</button></div>'+finnhubIVHtml+'<div id="tickStream_'+resId+'"></div></div>';
  el.innerHTML=tickerHdrHTML;
  function getTickStream(){return document.getElementById('tickStream_'+resId);}
  var accumulated='';
  try{
    console.log('MB: prompt built, length=',prompt.length);
    var resp=await fetch(S.proxyUrl+'/api/quote?claude=1',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:1500,stream:true,tools:[{type:'web_search_20250305',name:'web_search',max_uses:2}],messages:[{role:'user',content:prompt}]})});
    console.log('MB: API response status=',resp.status);
    if(!resp.ok){var er=await resp.json().catch(function(){return{};});throw new Error((er.error&&er.error.message)||'API error '+resp.status);}
    var reader=resp.body.getReader(), decoder=new TextDecoder(), buf='';
    function applyPrevDay(t){
      if(prevDay==='yesterday') return t;
      return t.replace(/yesterday[\u2018\u2019\u02bc'`\u2032]s/gi,prevDay+"'s").replace(/yesterday/gi,prevDay);
    }
    while(true){
      var _r=await reader.read(); if(_r.done)break;
      buf+=decoder.decode(_r.value,{stream:true});
      var lines=buf.split('\n'); buf=lines.pop();
      for(var li=0;li<lines.length;li++){
        var ln=lines[li].trim(); if(!ln.startsWith('data:'))continue;
        var json=ln.slice(5).trim(); if(json==='[DONE]')continue;
        try{var ev=JSON.parse(json);
          if(ev.type==='content_block_start'&&ev.content_block&&ev.content_block.type==='tool_use'){
            var _cdN=document.getElementById('cdNum');if(_cdN)_cdN.textContent='searching…';}
          if(ev.type==='content_block_delta'&&ev.delta&&ev.delta.type==='text_delta'){
            accumulated+=ev.delta.text;
            if(!_tcdFirst){_tcdFirst=true;clearInterval(_tcdTimer);var _tcdDiv=document.getElementById('tickCd_'+resId);if(_tcdDiv)_tcdDiv.style.display='none';}
            var ts=getTickStream();
            if(ts) ts.innerHTML=formatSummary(cleanAIText(applyPrevDay(stripIVPreamble(accumulated))));
          }
        }catch(_){}
      }
    }
    clearInterval(_tcdTimer);
    var _tcd2=document.getElementById('tickCd_'+resId);if(_tcd2)_tcd2.style.display='none';
    var _disc='\n\n---\n_This analysis is AI-generated for informational purposes only. Not financial advice. Do your own research before investing._';
    var ts=getTickStream(); if(ts) ts.innerHTML=formatSummary(cleanAIText(applyPrevDay(stripIVPreamble(accumulated)))+_disc);
    // Save with slight delay to ensure DOM is fully updated
    setTimeout(function(){
      var _tr=document.getElementById('tickRes')||document.getElementById('tickResD');
      if(_tr&&_tr.innerHTML&&_tr.innerHTML.length>200) savedSearchHTML=_tr.innerHTML;
    },100);
  }catch(e){el.innerHTML='<div class="msg err">Analysis error: '+esc(e.message)+'</div>';}
}


// ── About AI (company summary) ────────────────────────────────────────────────
async function triggerAboutAI(sym,resId,btn,companyName){
  // Restore analyse button if it was hidden
  var _anBtn=document.getElementById('anBtn_'+resId)||document.querySelector('#tc_'+resId+' .analyze-btn:not(.about-btn)');
  if(_anBtn) _anBtn.style.display='';
  btn.disabled=true; btn.textContent='Loading…';
  var el=document.getElementById('tai_'+resId); if(!el)return;
  var _acdSec=12,_acdFirst=false;
  el.innerHTML='<div class="msg">Loading overview… <span id="acdNum_'+resId+'">~'+_acdSec+'s</span></div>';
  var _acdTimer=setInterval(function(){
    _acdSec--;
    var n=document.getElementById('acdNum_'+resId);
    if(n&&_acdSec>0) n.textContent='~'+_acdSec+'s';
    else if(_acdSec<=0) clearInterval(_acdTimer);
  },1000);
  var name=sym;
  var displayName=companyName&&companyName!==sym?companyName:sym;
  var aboutHdr='<div class="sumbox" style="margin-top:10px"><div class="sumhdr"><span class="badge" style="background:var(--mut);">ℹ About</span><span class="sumdate" style="margin-left:6px">'+esc(displayName)+' ('+esc(sym)+')</span></div>'
    +'<div id="aboutCd_'+resId+'" class="msg">Loading overview… <span id="acdNum_'+resId+'">~12s</span></div>'
    +'<div id="aboutStream_'+resId+'"></div></div>';
  el.innerHTML=aboutHdr;
  function getAboutStream(){return document.getElementById('aboutStream_'+resId);}
  var accumulated='';
  try{
    var prompt='Search for "'+sym+'" ('+displayName+') and write a concise factual overview. '
      +'Go straight into describing the company — do NOT start with a sentence like "X is the ticker for Y" or restate the company name as an opener. '
      +'Cover: what the company does, exchange and sector, market cap tier, and 2-3 things a Singapore investor should know (dividends, key risks, revenue drivers). '
      +'Be specific and factual. Write in plain English. No markdown bold (**) or headers.'
    console.log('MB: prompt built, length=',prompt.length);
    var resp=await fetch(S.proxyUrl+'/api/quote?claude=1',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:700,stream:true,tools:[{type:'web_search_20250305',name:'web_search',max_uses:2}],messages:[{role:'user',content:prompt}]})});
    console.log('MB: API response status=',resp.status);
    if(!resp.ok){var er=await resp.json().catch(function(){return{};});throw new Error((er.error&&er.error.message)||'API error '+resp.status);}
    var reader=resp.body.getReader(),decoder=new TextDecoder(),buf='';
    while(true){
      var _r=await reader.read(); if(_r.done)break;
      buf+=decoder.decode(_r.value,{stream:true});
      var lines=buf.split('\n'); buf=lines.pop();
      for(var li=0;li<lines.length;li++){
        var ln=lines[li].trim(); if(!ln.startsWith('data:'))continue;
        var json=ln.slice(5).trim(); if(json==='[DONE]')continue;
        try{var ev=JSON.parse(json);
          if(ev.type==='content_block_start'&&ev.content_block&&ev.content_block.type==='tool_use'){
            var _cdN=document.getElementById('cdNum');if(_cdN)_cdN.textContent='searching…';}
          if(ev.type==='content_block_delta'&&ev.delta&&ev.delta.type==='text_delta'){
            accumulated+=ev.delta.text;
            if(!_acdFirst){_acdFirst=true;clearInterval(_acdTimer);var _acdDiv=document.getElementById('aboutCd_'+resId);if(_acdDiv)_acdDiv.style.display='none';}
            var ts=getAboutStream();
            if(ts) ts.innerHTML=formatSummary(cleanAIText(accumulated));
          }
        }catch(_){}
      }
    }
    clearInterval(_acdTimer);
    var _acd2=document.getElementById('aboutCd_'+resId);if(_acd2)_acd2.style.display='none';
    var ts=getAboutStream(); if(ts) ts.innerHTML=formatSummary(cleanAIText(accumulated));
    setTimeout(function(){
      var _tr=document.getElementById('tickRes')||document.getElementById('tickResD');
      if(_tr&&_tr.innerHTML&&_tr.innerHTML.length>200) savedSearchHTML=_tr.innerHTML;
    },100);
    btn.textContent='ℹ About'; btn.disabled=false;
  }catch(e){
    el.innerHTML='<div class="msg err">Error: '+esc(e.message)+'</div>';
    btn.textContent='ℹ About'; btn.disabled=false;
  }
}
// ── PDF Export ─────────────────────────────────────────────────────
function exportToPDF(type){
  var contentEl=null, title='MarketBrief';
  if(type==='sum'){
    var a=document.getElementById('sumArea'),b=document.getElementById('sumAreaD');
    contentEl=(b&&b.offsetParent!==null)?b:a;
    title='MarketBrief AI Summary';
  } else if(type.indexOf('tick_')===0){
    var resId=type.slice(5);
    contentEl=document.getElementById('tai_'+resId);
    var sym=document.querySelector('#tc_'+resId+' .tsym');
    title='MarketBrief Analysis'+(sym?' — '+sym.textContent:'');
  }
  if(!contentEl||!contentEl.innerHTML)return;

  var btn=document.querySelector('.pdf-btn[data-export="'+type+'"]');
  if(btn){btn.textContent='Generating…';btn.disabled=true;}

  var now=new Date();
  var ds=now.toLocaleDateString('en-SG',{timeZone:'Asia/Singapore',year:'numeric',month:'short',day:'numeric'});
  var ts=now.toLocaleTimeString('en-SG',{timeZone:'Asia/Singapore',hour:'2-digit',minute:'2-digit'});

  // Remap all CSS variable colour references to hardcoded print values
  var html=contentEl.innerHTML
    .replace(/color:var\(--acc\)/g,'color:#005b8e')
    .replace(/color:var\(--orange\)/g,'color:#7c2d00')
    .replace(/color:var\(--txt\)/g,'color:#111111')
    .replace(/color:var\(--mut\)/g,'color:#444444')
    .replace(/color:var\(--grn\)/g,'color:#146b3a')
    .replace(/color:var\(--red\)/g,'color:#b91c1c')
    .replace(/color:var\(--gld\)/g,'color:#92610a')
    .replace(/color:var\(--bg\)/g,'color:#000000')
    .replace(/background:linear-gradient[^;"]+/g,'background:#f0f4ff')
    .replace(/background:rgba\(0,212,255[^)]*\)/g,'background:#e8f4fb')
    .replace(/background:rgba\(124,58,237[^)]*\)/g,'background:#f0eeff')
    .replace(/background:rgba\(16,185,129[^)]*\)/g,'background:#e8f8f0')
    .replace(/background:rgba\(100,116,139[^)]*\)/g,'background:#f0f0f0')
    .replace(/background:rgba\([^)]*\)/g,'background:#f5f5f5')
    .replace(/border-left:3px solid var\(--acc\)/g,'border-left:3px solid #005b8e')
    .replace(/border-bottom:1px solid rgba\(249,115,22[^)]*\)/g,'border-bottom:1px solid #c07040')
    .replace(/border-top:1px solid var\(--bor\)/g,'border-top:1px solid #cccccc')
    .replace(/border:1px solid var\(--bor\)/g,'border:1px solid #cccccc')
    .replace(/border:1px solid rgba\(0,212,255[^)]*\)/g,'border:1px solid #a0cce0')
    .replace(/border:1px solid rgba\([^)]*\)/g,'border:1px solid #dddddd');

  // Full self-contained HTML with no CSS variable references
  var pageHtml='<!DOCTYPE html><html><head><meta charset="UTF-8">'
    +'<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">'
    +'<style>'
    +'*{box-sizing:border-box;margin:0;padding:0;}'
    +'body{font-family:"DM Mono",monospace;background:#ffffff;color:#111111;font-size:13px;line-height:1.75;width:760px;padding:40px;}'
    +'a{color:#005b8e;text-decoration:underline;word-break:break-all;}'
    +'strong{color:#005b8e;font-weight:700;}'
    +'em{color:#444444;font-style:italic;font-size:0.92em;}'
    +'hr{border:none;border-top:1px solid #cccccc;margin:8px 0;}'
    +'</style></head><body>'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #111111;">'
    +'<div style="font-family:Syne,sans-serif;font-weight:800;font-size:22px;color:#111111;">Market<span style="color:#005b8e;">Brief</span></div>'
    +'<div style="text-align:right;font-size:11px;color:#444444;line-height:1.6;"><div style="font-weight:600;color:#111111;">'+title+'</div><div>'+ds+' · '+ts+' SGT</div></div>'
    +'</div>'
    +'<div id="pdfcontent" style="color:#111111;">'+html+'</div>'
    +'</body></html>';

  function loadScript(src,cb){
    if(document.querySelector('script[src="'+src+'"]')){cb();return;}
    var s=document.createElement('script');s.src=src;s.onload=cb;document.head.appendChild(s);
  }

  loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',function(){
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',function(){

      // Create iframe — must be in DOM and have real dimensions for html2canvas to work.
      // We use opacity:0 + pointer-events:none so it's invisible but laid out correctly.
      var iframe=document.createElement('iframe');
      iframe.style.cssText='position:fixed;top:0;left:0;width:760px;height:900px;border:none;opacity:0;pointer-events:none;z-index:-1;';
      document.body.appendChild(iframe);

      var idoc=iframe.contentDocument||iframe.contentWindow.document;
      idoc.open(); idoc.write(pageHtml); idoc.close();

      // Wait for fonts + layout to settle inside iframe
      setTimeout(function(){
        var iBody=idoc.body;
        var naturalH=iBody.scrollHeight||900;
        iframe.style.height=naturalH+'px';

        // Give layout one more tick after height set
        setTimeout(function(){
          window.html2canvas(iBody,{
            scale:2,
            useCORS:true,
            backgroundColor:'#ffffff',
            logging:false,
            width:760,
            height:naturalH,
            windowWidth:760,
            windowHeight:naturalH,
            scrollX:0,
            scrollY:0
          }).then(function(canvas){
            document.body.removeChild(iframe);
            var jspdf=window.jspdf||window.jsPDF;
            var pdf=new (jspdf.jsPDF||jspdf)({orientation:'portrait',unit:'pt',format:'a4'});
            var pageW=pdf.internal.pageSize.getWidth();
            var pageH=pdf.internal.pageSize.getHeight();
            var margin=30;
            var printW=pageW-margin*2;
            var imgScale=printW/canvas.width;
            var sliceH=Math.floor((pageH-margin*2)/imgScale); // canvas px per PDF page
            var totalPages=Math.ceil(canvas.height/sliceH);
            for(var i=0;i<totalPages;i++){
              if(i>0) pdf.addPage();
              var sy=i*sliceH;
              var sh=Math.min(sliceH,canvas.height-sy);
              var slice=document.createElement('canvas');
              slice.width=canvas.width;
              slice.height=sh;
              var ctx2=slice.getContext('2d');
              ctx2.fillStyle='#ffffff';
              ctx2.fillRect(0,0,slice.width,sh);
              ctx2.drawImage(canvas,0,sy,canvas.width,sh,0,0,canvas.width,sh);
              pdf.addImage(slice.toDataURL('image/png'),'PNG',margin,margin,printW,sh*imgScale);
            }
            var fname=title.replace(/[^a-zA-Z0-9 ]/g,'_').replace(/\s+/g,'_').toLowerCase()+'.pdf';
            pdf.save(fname);
            if(btn){btn.textContent='PDF';btn.disabled=false;}
          }).catch(function(err){
            console.error('PDF error:',err);
            document.body.removeChild(iframe);
            if(btn){btn.textContent='PDF';btn.disabled=false;}
          });
        },100);
      },1500);
    });
  });
}

// ── Summary formatter ─────────────────────────────────────────────────────────
function cleanAIText(txt){
  var lines=txt.split('\n');
  var cleaned=[];
  for(var i=0;i<lines.length;i++){
    var l=lines[i]; var t=l.trim().toLowerCase();
    if(!t){cleaned.push(l);continue;}
    // Drop any line that is pure AI meta-commentary
    if(/^(based on|according to my|from my|using my|after (searching|reviewing|checking|looking)|i (have|can now|will now|am going to|need to|should|would|found|searched|looked)|let me |here('s| is) (my|the|a|an) (analysis|summary|overview|breakdown|look)|i'd like to|i'll |i've |great[,!]|certainly[,!]|sure[,!]|of course)/i.test(t)) continue;
    cleaned.push(l);
  }
  return cleaned.join('\n').replace(/^[\s\n]+/,'');
}
function applyInlineMarkdown(escaped){
  return escaped
    .replace(/\*\*([^*]+)\*\*/g,'<strong style="font-family:DM Mono,monospace;font-weight:500;color:var(--acc);">$1</strong>')
    .replace(/\*([^*]+)\*/g,'<em>$1</em>')
    .replace(/_([^_]+)_/g,'<em style="color:var(--mut);font-size:0.95rem;">$1</em>');
}
function safeLineHtml(line){
  // Split line into text/url segments, esc() text only, wrap URLs in <a>
  var result='';
  var urlRe=/(https?:\/\/[^\s]+)/g;
  var last=0; var m;
  while((m=urlRe.exec(line))!==null){
    result+=applyInlineMarkdown(esc(line.slice(last,m.index)));
    var url=m[1].replace(/[.,;:!?)]+$/,'');
    var display=url.replace(/^https?:\/\//,'');
    if(display.length>55) display=display.substring(0,55)+'…';
    result+='<a href="'+url+'" target="_blank" rel="noopener" style="color:var(--acc);text-decoration:underline;word-break:break-all;">'+display+'</a>';
    last=m.index+m[1].length;
  }
  result+=applyInlineMarkdown(esc(line.slice(last)));
  return result;
}
function formatSummary(txt){
  var html='';
  txt.split('\n').forEach(function(line){
    line=line.trim();
    if(!line){html+='<div style="height:6px"></div>';return;}
    if(line==='---'){html+='<hr style="border:none;border-top:1px solid var(--bor);margin:8px 0">';return;}
    var stripped=line.replace(/^#+\s*/,'').replace(/^[1-9][.)\s]+/,'').trim();
    var isHeader=/^#/.test(line)||/^[1-9][.)]\s/.test(line.trim())||stripped.charCodeAt(0)>255;
    if(isHeader&&line.indexOf('**')===-1){
      html+='<div style="font-family:Syne,sans-serif;font-weight:700;font-size:1.15rem;color:var(--orange);margin-top:20px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid rgba(249,115,22,0.25);">'+esc(stripped)+'</div>';
    } else if(/^[-•*]/.test(line)){
      html+='<div style="display:flex;gap:8px;margin-bottom:7px;"><span style="color:var(--orange);flex-shrink:0;margin-top:3px">›</span><span style="font-size:1.05rem;line-height:1.8;color:var(--txt);">'+safeLineHtml(line.replace(/^[-•*]\s*/,''))+'</span></div>';
    } else if(/^MB Value:/i.test(line)){
      var _mbParts=line.split('|');
      var _mbFirst=_mbParts[0].trim();
      var _mbRest=_mbParts.slice(1).map(function(p){return p.trim();}).join(' | ');
      var _mbHtml='<strong style="text-decoration:underline;font-weight:700;">'+esc(_mbFirst)+'</strong>'
        +(_mbRest?' | '+safeLineHtml(_mbRest):'');
      html+='<div style="margin-top:8px;font-size:1.05rem;line-height:1.7;color:var(--acc);">'+_mbHtml+'</div>';
    } else if(/^Outlook:/i.test(line)||/^Sentiment:/i.test(line)||/^Verdict:/i.test(line)){
      html+='<div style="margin-top:14px;padding:10px 14px;background:rgba(0,212,255,0.07);border-left:3px solid var(--acc);border-radius:0 8px 8px 0;font-size:1.05rem;line-height:1.7;color:var(--acc);">'+safeLineHtml(line)+'</div>';
    } else if(/^[^:]{3,60}:\s*https?:\/\//.test(line)){
      var _ci=line.indexOf(':');
      var _label=line.slice(0,_ci).trim();
      var _url=line.slice(_ci+1).trim();
      var _urlClean=_url.replace(/[.,;:!?)]+$/,'');
      html+='<div style="margin-bottom:8px;"><a href="'+_urlClean+'" target="_blank" rel="noopener" style="color:var(--acc);text-decoration:underline;font-size:1.05rem;line-height:1.8;">'+esc(_label)+'</a></div>';
    } else {
      html+='<div style="font-size:1.05rem;line-height:1.8;color:var(--txt);margin-bottom:4px;">'+safeLineHtml(line)+'</div>';
    }
  });
  return html;
}

// ── Settings ──────────────────────────────────────────────────────────────────
function doChangePIN(pid){
  var cur=document.getElementById('cfgCurPin_'+pid).value||'';
  var nw=document.getElementById('cfgNewPin_'+pid).value||'';
  var cf=document.getElementById('cfgConPin_'+pid).value||'';
  var msg=document.getElementById('pinChgMsg_'+pid);
  changePIN(cur,nw,cf).then(function(result){
    if(result==='ok'){
      msg.innerHTML='<div class="msg ok" style="margin-top:4px">&#x2713; PIN updated.</div>';
      document.getElementById('cfgCurPin_'+pid).value='';
      document.getElementById('cfgNewPin_'+pid).value='';
      document.getElementById('cfgConPin_'+pid).value='';
    } else {
      msg.innerHTML='<div class="msg err" style="margin-top:4px">'+esc(result)+'</div>';
    }
    setTimeout(function(){msg.innerHTML='';},3000);
  });
}

function renderSettingsPanelTo(pid){
  var el=document.getElementById(pid); if(!el)return;

  function mktSection(mkt,flag,label){
    var fixed=S.fixedTickers.filter(function(t){return t.mkt===mkt;});
    var custom=S.customTickers[mkt]||[];
    var fixedHtml=fixed.map(function(t){return '<span class="ttag fixed">🔒 '+esc(t.sym)+'</span>';}).join('');
    var customHtml=custom.map(function(t,i){
      return '<span class="ttag">'
        +'<button class="mv" onclick="moveTicker(\''+mkt+'\','+i+',-1,\''+pid+'\')">↑</button>'
        +'<button class="mv" onclick="moveTicker(\''+mkt+'\','+i+',1,\''+pid+'\')">↓</button>'
        +esc(t.sym)+' <button class="del" onclick="removeTicker(\''+mkt+'\','+i+',\''+pid+'\')">×</button>'
        +'</span>';
    }).join('');
    var iid='settAC_'+mkt+'_'+pid;
    return '<div class="mkt-section">'
      +'<div class="mkt-section-title">'+flag+' '+label+'</div>'
      +'<div class="ticker-tags">'+fixedHtml+customHtml+'</div>'
      +'<div class="tadd-ac-wrap" id="sAcWrap_'+mkt+'_'+pid+'">'
        +'<input class="tadd-ac-input" id="'+iid+'" placeholder="Search to add '+label+' ticker…" autocomplete="off">'
      +'</div>'
      +'</div>';
  }

  el.innerHTML=
    '<div class="srow" style="border-color:rgba(0,212,255,0.4)">'
      +'<div class="slbl" style="color:var(--acc)">★ Proxy URL</div>'
      +'<input class="sinp" type="url" id="cfgProxy_'+pid+'" placeholder="https://mb-proxy.vercel.app" value="'+esc(S.proxyUrl)+'">'
      +'<div class="snote">Your Vercel proxy URL for live market data.</div>'
    +'</div>'

    +'<div class="srow">'
      +'<div class="slbl">Watchlist — by Market</div>'
      +'<div class="snote" style="margin-bottom:12px">🔒 Index tickers are fixed. Use ↑↓ to reorder. Search by name to add.</div>'
      +mktSection('US','🇺🇸','US Stocks')
      +mktSection('SG','🇸🇬','SGX Stocks')
      +mktSection('HK','🇭🇰','HKEX Stocks')
    +'</div>'
    +'<div class="srow">'
      +'<div class="slbl">Summary Style</div>'
      +'<select class="sinp" id="cfgStyle_'+pid+'">'
        +'<option value="detailed"'+(S.style==='detailed'?' selected':'')+'>Detailed paragraph</option>'
        +'<option value="concise"'+(S.style==='concise'?' selected':'')+'>Concise (1 sentence each)</option>'
        +'<option value="bullets"'+(S.style==='bullets'?' selected':'')+'>Bullet points</option>'
      +'</select>'
    +'</div>'
    +'<div class="srow">'
      +'<div class="slbl">Timezone</div>'
      +'<select class="sinp" id="cfgTz_'+pid+'">'
        +'<option value="Asia/Singapore"'+(S.tz==='Asia/Singapore'?' selected':'')+'>Singapore SGT (UTC+8)</option>'
        +'<option value="Asia/Hong_Kong"'+(S.tz==='Asia/Hong_Kong'?' selected':'')+'>Hong Kong HKT (UTC+8)</option>'
        +'<option value="America/New_York"'+(S.tz==='America/New_York'?' selected':'')+'>New York ET</option>'
        +'<option value="UTC"'+(S.tz==='UTC'?' selected':'')+'>UTC</option>'
      +'</select>'
    +'</div>'
    +'<button class="savebtn" onclick="saveSettings(\''+pid+'\')">Save Settings</button>'
    +'<div id="saveMsg_'+pid+'"></div>'
    +'<div class="srow" style="border-color:rgba(0,212,255,0.25)">'
      +'<div class="slbl" style="color:var(--acc)">⇅ Sync Settings</div>'
      +'<div class="snote">Export your settings as a code to copy to another device, or paste a code here to import.</div>'
      +'<button class="savebtn" style="margin-top:8px;background:rgba(0,212,255,0.1);border-color:rgba(0,212,255,0.3);color:var(--acc)" onclick="exportSettings(\''+pid+'\')">⬆ Export Settings Code</button>'
      +'<div id="expOut_'+pid+'"></div>'
      +'<textarea class="sinp" id="impInp_'+pid+'" placeholder="Paste settings code here to import…" rows="3" style="margin-top:10px;font-size:0.8rem;resize:vertical;"></textarea>'
      +'<button class="savebtn" style="margin-top:6px;" onclick="importSettings(\''+pid+'\')">⬇ Import Settings Code</button>'
      +'<div id="impMsg_'+pid+'"></div>'
    +'</div>'
    +'<div class="srow" style="border-color:rgba(0,212,255,0.25)">'
      +'<div class="slbl" style="color:var(--acc)">&#x1F512; Change PIN</div>'
      +'<input class="sinp" type="password" id="cfgCurPin_'+pid+'" placeholder="Current PIN" maxlength="6" style="margin-bottom:8px">'
      +'<input class="sinp" type="password" id="cfgNewPin_'+pid+'" placeholder="New PIN (6 digits)" maxlength="6" style="margin-bottom:8px">'
      +'<input class="sinp" type="password" id="cfgConPin_'+pid+'" placeholder="Confirm new PIN" maxlength="6" style="margin-bottom:8px">'
      +'<button class="savebtn" style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.3);color:var(--acc)" onclick="doChangePIN(\''+pid+'\')" >Update PIN</button>'
      +'<div id="pinChgMsg_'+pid+'" style="margin-top:6px"></div>'
    +'</div>'
    +'<div class="srow" style="border-color:rgba(239,68,68,0.2)">'
      +'<div class="slbl" style="color:var(--red)">Disclaimer</div>'
      +'<div class="snote" style="margin:0">Data via Yahoo Finance (15–20 min delay). For informational purposes only — not financial advice.</div>'
    +'</div>';

  // Attach autocomplete to each market add input
  ['US','SG','HK'].forEach(function(mkt){
    var iid='settAC_'+mkt+'_'+pid;
    var wid='sAcWrap_'+mkt+'_'+pid;
    var inp=document.getElementById(iid); if(!inp)return;
    inp.addEventListener('input',function(){
      var v=this.value.trim();
      clearTimeout(acTimers[iid]);
      if(v.length<2){closeSettAcDrop(wid);return;}
      acTimers[iid]=setTimeout(function(){settAcFetch(v,wid,mkt,pid);},320);
    });
    inp.addEventListener('keydown',function(e){
      if(e.key==='Escape') closeSettAcDrop(wid);
    });
  });
}

async function settAcFetch(q,wid,mkt,pid){
  if(!S.proxyUrl) return;
  try{
    var r=await fetch(S.proxyUrl+'/api/quote?search='+encodeURIComponent(q));
    var data=await r.json();
    var results=(data.results||[]).slice(0,6);
    renderSettAcDrop(results,wid,mkt,pid);
  }catch(e){ closeSettAcDrop(wid); }
}

function renderSettAcDrop(results,wid,mkt,pid){
  closeSettAcDrop(wid);
  if(!results.length)return;
  // Filter results to only show tickers belonging to the correct market
  var filtered=results.filter(function(r){
    var sym=r.symbol||'';
    if(mkt==='SG') return sym.endsWith('.SI');
    if(mkt==='HK') return sym.endsWith('.HK');
    if(mkt==='US') return !sym.endsWith('.SI')&&!sym.endsWith('.HK')&&!sym.includes('.');
    return true;
  });
  if(!filtered.length)return;
  var drop=document.createElement('div');
  drop.className='tadd-ac-drop'; drop.id='drop_'+wid;
  drop.innerHTML=filtered.map(function(r){
    return '<div class="tadd-ac-item" data-sym="'+esc(r.symbol)+'" data-name="'+esc(r.name)+'">'
      +'<div><div class="tadd-ac-sym">'+esc(r.symbol)+'</div><div class="tadd-ac-name">'+esc(r.name)+'</div></div>'
      +'<div class="tadd-ac-add">+ Add</div>'
      +'</div>';
  }).join('');
  drop.querySelectorAll('.tadd-ac-item').forEach(function(item){
    item.addEventListener('click',function(){
      addTickerDirect(mkt,this.dataset.sym,this.dataset.name,pid);
      closeSettAcDrop(wid);
      var iid='settAC_'+mkt+'_'+pid;
      var inp=document.getElementById(iid); if(inp) inp.value='';
    });
  });
  document.getElementById(wid).appendChild(drop);
}

function closeSettAcDrop(wid){
  var d=document.getElementById('drop_'+wid); if(d) d.remove();
}

function addTickerDirect(mkt,sym,name,pid){
  var all=getAllTickers().map(function(t){return t.sym;});
  if(all.indexOf(sym)>-1)return;
  var flag=sym.endsWith('.L')?'🇬🇧':({'US':'🇺🇸','SG':'🇸🇬','HK':'🇭🇰'}[mkt]||'🌐');
  var sub=sym.endsWith('.L')?'UK · LSE':({'US':'US · NYSE/Nasdaq','SG':'SG · SGX','HK':'HK · HKEX'}[mkt]||'');
  S.customTickers[mkt].push({sym:sym,name:name||sym,sub:sub,flag:flag,mkt:mkt});
  renderSettingsPanelTo(pid);
}

function removeTicker(mkt,idx,pid){ S.customTickers[mkt].splice(idx,1); renderSettingsPanelTo(pid); }
function moveTicker(mkt,idx,dir,pid){
  var arr=S.customTickers[mkt], ni=idx+dir;
  if(ni<0||ni>=arr.length)return;
  var tmp=arr[idx];arr[idx]=arr[ni];arr[ni]=tmp;
  renderSettingsPanelTo(pid);
}

function exportSettings(pid){
  var data={proxyUrl:S.proxyUrl,style:S.style,tz:S.tz,customTickers:S.customTickers};
  var code=btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  var out=document.getElementById('expOut_'+pid);
  var codeId='expCode_'+pid;
  var btnId='expCopyBtn_'+pid;
  out.innerHTML='<div style="margin-top:8px"><textarea class="sinp" rows="3" id="'+codeId+'" style="font-size:0.75rem;resize:none;" readonly>'+code+'</textarea>'
    +'<button class="savebtn" id="'+btnId+'" style="margin-top:4px;background:rgba(0,212,255,0.1);border-color:rgba(0,212,255,0.3);color:var(--acc)">Copy Code</button></div>';
  document.getElementById(btnId).onclick=function(){
    var t=document.getElementById(codeId); t.select(); t.setSelectionRange(0,99999);
    try{navigator.clipboard.writeText(t.value);}catch(e){document.execCommand('copy');}
    this.textContent='✓ Copied!';
    setTimeout(function(){document.getElementById(btnId).textContent='Copy Code';},2000);
  };
}
function importSettings(pid){
  var msg=document.getElementById('impMsg_'+pid);
  var raw=(document.getElementById('impInp_'+pid).value||'').trim();
  if(!raw){msg.innerHTML='<div class="msg err" style="margin-top:6px">Paste a settings code first.</div>';setTimeout(function(){msg.innerHTML='';},3000);return;}
  try{
    var data=JSON.parse(decodeURIComponent(escape(atob(raw))));
    if(data.proxyUrl!==undefined) S.proxyUrl=data.proxyUrl;
    if(data.style!==undefined)    S.style=data.style;
    if(data.tz!==undefined)       S.tz=data.tz;
    if(data.customTickers)        S.customTickers=data.customTickers;
    storeSave({proxyUrl:S.proxyUrl,style:S.style,tz:S.tz,customTickers:S.customTickers});
    msg.innerHTML='<div class="msg ok" style="margin-top:6px">✓ Settings imported! Reloading…</div>';
    setTimeout(function(){location.reload();},1200);
  }catch(e){
    msg.innerHTML='<div class="msg err" style="margin-top:6px">Invalid code. Please try again.</div>';
    setTimeout(function(){msg.innerHTML='';},3000);
  }
}
function storeSave(data){
  var str=JSON.stringify(data);
  try{ localStorage.setItem('mb5',str); return 'local'; }catch(e){}
  try{ sessionStorage.setItem('mb5',str); return 'session'; }catch(e){}
  return 'memory';
}
function storeLoad(){
  try{ var v=localStorage.getItem('mb5'); if(v) return JSON.parse(v); }catch(e){}
  try{ var v=sessionStorage.getItem('mb5'); if(v) return JSON.parse(v); }catch(e){}
  return {};
}
function saveSettings(pid){
  S.proxyUrl=(document.getElementById('cfgProxy_'+pid).value||'').trim().replace(/\/+$/,'');
  S.style   =document.getElementById('cfgStyle_'+pid).value;
  S.tz      =document.getElementById('cfgTz_'+pid).value;
  var result=storeSave({proxyUrl:S.proxyUrl,style:S.style,tz:S.tz,customTickers:S.customTickers});
  var m=document.getElementById('saveMsg_'+pid);
  if(result==='memory'){
    m.innerHTML='<div class="msg err" style="margin-top:6px">⚠ Storage blocked by browser — settings saved for this session only. Check Safari Settings → Privacy and disable Private Browsing or allow website data.</div>';
    setTimeout(function(){m.innerHTML='';},6000);
  } else {
    m.innerHTML='<div class="msg ok" style="margin-top:6px">✓ Saved'+(result==='session'?' (session only)':'')+'.</div>';
    setTimeout(function(){m.innerHTML='';},2000);
  }
}
function loadSettings(){
  try{
    var s=storeLoad();
    if(s.proxyUrl) S.proxyUrl=s.proxyUrl;
    if(s.style)    S.style=s.style;
    if(s.tz)       S.tz=s.tz;
    if(s.customTickers)['US','SG','HK'].forEach(function(m){if(s.customTickers[m])S.customTickers[m]=s.customTickers[m];});
  }catch(e){}
}

function fmt(n){if(n===null||n===undefined)return '—';return Number(n).toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});}
function fmtVol(v){
  if(v===null||v===undefined||v===0||v==='0')return '—';
  var n=Number(v);
  if(isNaN(n)||n<=0)return '—';
  if(n>=1e9)return (n/1e9).toFixed(2)+'B';
  if(n>=1e6)return (n/1e6).toFixed(2)+'M';
  if(n>=1e3)return (n/1e3).toFixed(1)+'K';
  return n.toString();
}
function fmtP(p){if(p===null||p===undefined)return '—';return(p>=0?'+':'')+Number(p).toFixed(3)+'%';}
function fmtD(d){if(d===null||d===undefined)return '—';return(d>=0?'+':'')+Number(d).toFixed(3);}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
</script>
</body>
</html>
