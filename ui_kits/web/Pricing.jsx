// Pricing.jsx — three tiers
function Pricing() {
  const tiers = [
    { name:'SOLO', price:'$0', per:'/forever', note:'For tinkerers and toy projects.', features:['1 project','10K keys/mo','Community support'], cta:'Start free', highlight:false },
    { name:'TEAM', price:'$24', per:'/seat / mo', note:'For shipping teams.', features:['Unlimited projects','5M keys/mo','Audit log + SSO','Priority support'], cta:'Start a trial', highlight:true },
    { name:'SCALE', price:'Custom', per:'', note:'For everyone else.', features:['Dedicated regions','99.99% SLA','Solutions engineer','Custom contracts'], cta:'Talk to sales', highlight:false },
  ];
  return (
    <section style={pStyles.wrap}>
      <div style={pStyles.head}>
        <div style={pStyles.eyebrow}>// 04 — PRICING</div>
        <h2 style={pStyles.h2}>Pay for what you ship.</h2>
      </div>
      <div style={pStyles.grid}>
        {tiers.map(t => (
          <div key={t.name} style={{...pStyles.card, ...(t.highlight ? pStyles.cardHi : {})}}>
            <div style={pStyles.tName}>{t.name}</div>
            <div style={pStyles.priceRow}>
              <span style={pStyles.price}>{t.price}</span>
              <span style={pStyles.per}>{t.per}</span>
            </div>
            <div style={pStyles.note}>{t.note}</div>
            <ul style={pStyles.feats}>
              {t.features.map(f => (
                <li key={f} style={pStyles.feat}><span style={{...pStyles.featDot, background: t.highlight?'#0A0908':'#FF5A1F'}}/>{f}</li>
              ))}
            </ul>
            <button style={{...pStyles.cta, ...(t.highlight ? pStyles.ctaHi : {})}}>{t.cta} <span style={{fontFamily:'JetBrains Mono'}}>→</span></button>
          </div>
        ))}
      </div>
    </section>
  );
}

const pStyles = {
  wrap: { padding:'96px 32px', borderBottom:'1.5px solid #0A0908', background:'#F2EBDD' },
  head: { marginBottom:48 },
  eyebrow: { fontFamily:'JetBrains Mono', fontSize:12, letterSpacing:'0.16em', textTransform:'uppercase', color:'#6B6259', marginBottom:14 },
  h2: { fontFamily:'Space Grotesk', fontWeight:700, fontSize:56, letterSpacing:'-0.03em', margin:0, color:'#0A0908', lineHeight:1.05 },
  grid: { display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:24 },
  card: { background:'#FAF6EE', border:'2px solid #0A0908', padding:28, display:'flex', flexDirection:'column', gap:14, minHeight:380 },
  cardHi: { background:'#FF5A1F', boxShadow:'6px 6px 0 0 #0A0908' },
  tName: { fontFamily:'JetBrains Mono', fontSize:12, letterSpacing:'0.16em', textTransform:'uppercase', color:'#0A0908' },
  priceRow: { display:'flex', alignItems:'baseline', gap:6, marginTop:6 },
  price: { fontFamily:'Space Grotesk', fontWeight:700, fontSize:54, letterSpacing:'-0.04em', color:'#0A0908', lineHeight:1 },
  per: { fontFamily:'Inter Tight', fontSize:14, color:'#2A2520' },
  note: { fontFamily:'Inter Tight', fontSize:14, color:'#2A2520', marginBottom:8 },
  feats: { listStyle:'none', padding:0, margin:'4px 0 16px', display:'flex', flexDirection:'column', gap:8, flex:1 },
  feat: { display:'flex', alignItems:'center', gap:10, fontFamily:'Inter Tight', fontSize:14, color:'#0A0908' },
  featDot: { width:6, height:6, display:'inline-block' },
  cta: { fontFamily:'Space Grotesk', fontWeight:600, fontSize:15, padding:'12px 18px', background:'#0A0908', color:'#FAF6EE', border:'2px solid #0A0908', cursor:'pointer', boxShadow:'3px 3px 0 0 #FF5A1F' },
  ctaHi: { background:'#FAF6EE', color:'#0A0908', boxShadow:'3px 3px 0 0 #0A0908' },
};

window.Pricing = Pricing;
