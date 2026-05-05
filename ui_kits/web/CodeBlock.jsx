// CodeBlock.jsx — terminal-style snippet
function CodeBlock() {
  const lines = [
    { t:'comment', s:'// drop-in. one line. ship.' },
    { t:'code', s:'import { o1key } from "@o1key/edge"' },
    { t:'blank', s:'' },
    { t:'code', s:'export default async (req) => {' },
    { t:'code', s:'  const { user } = await o1key.verify(req)' },
    { t:'code', s:'  return Response.json({ ok: true, user })' },
    { t:'code', s:'}' },
  ];
  return (
    <section style={cbStyles.wrap}>
      <div style={cbStyles.frame}>
        <div style={cbStyles.head}>
          <div style={cbStyles.dots}>
            <span style={{...cbStyles.dot, background:'#FF5A1F'}}/>
            <span style={{...cbStyles.dot, background:'#F2B33D'}}/>
            <span style={{...cbStyles.dot, background:'#1FBFA8'}}/>
          </div>
          <span style={cbStyles.headTxt}>edge.ts · 0x1key/example</span>
          <span style={cbStyles.headTxt}>● LIVE</span>
        </div>
        <pre style={cbStyles.pre}>
{lines.map((l,i) => (
  <div key={i} style={cbStyles.line}>
    <span style={cbStyles.gutter}>{String(i+1).padStart(2,'0')}</span>
    <span style={l.t==='comment'?cbStyles.comment:cbStyles.code}>{l.s || ' '}</span>
  </div>
))}
        </pre>
      </div>
      <div style={cbStyles.side}>
        <div style={cbStyles.eyebrow}>// 03 — DROP-IN</div>
        <h2 style={cbStyles.h2}>Six lines. That's the integration.</h2>
        <p style={cbStyles.p}>No SDK to wire up. No middleware tax. Paste, deploy, watch the keys flow.</p>
        <a href="#" style={cbStyles.link}>See the full quickstart <span style={{fontFamily:'JetBrains Mono'}}>↗</span></a>
      </div>
    </section>
  );
}

const cbStyles = {
  wrap: { display:'grid', gridTemplateColumns:'1.3fr 1fr', gap:64, padding:'96px 32px', borderBottom:'1.5px solid #0A0908', alignItems:'center' },
  frame: { background:'#0A0908', border:'2px solid #0A0908', boxShadow:'6px 6px 0 0 #FF5A1F' },
  head: { display:'flex', alignItems:'center', gap:14, padding:'10px 14px', borderBottom:'1px solid #2A2520', justifyContent:'space-between' },
  dots: { display:'flex', gap:6 },
  dot: { width:10, height:10, borderRadius:999, display:'inline-block' },
  headTxt: { fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:'0.08em', textTransform:'uppercase', color:'#B8AFA3' },
  pre: { margin:0, padding:'18px 0', fontFamily:'JetBrains Mono', fontSize:14, lineHeight:1.7 },
  line: { display:'flex', gap:18, padding:'0 18px' },
  gutter: { color:'#6B6259', userSelect:'none', minWidth:24 },
  comment: { color:'#6B6259' },
  code: { color:'#FAF6EE' },

  side: { display:'flex', flexDirection:'column', gap:16 },
  eyebrow: { fontFamily:'JetBrains Mono', fontSize:12, letterSpacing:'0.16em', textTransform:'uppercase', color:'#6B6259' },
  h2: { fontFamily:'Space Grotesk', fontWeight:700, fontSize:44, letterSpacing:'-0.03em', margin:0, color:'#0A0908', lineHeight:1.05 },
  p: { fontFamily:'Inter Tight', fontSize:17, lineHeight:1.5, color:'#2A2520', margin:0 },
  link: { fontFamily:'Space Grotesk', fontWeight:600, fontSize:15, color:'#0A0908', textDecoration:'none', borderBottom:'2px solid #FF5A1F', paddingBottom:1, alignSelf:'flex-start' },
};

window.CodeBlock = CodeBlock;
