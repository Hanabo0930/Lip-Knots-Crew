// 装飾はCSSのtransformだけで動かし、業務操作と読み上げを妨げない。
export default function AdminAtmosphere(){return <div className="crew-atmosphere" aria-hidden="true">
  <div className="aurora aurora-violet"/><div className="aurora aurora-aqua"/>
  <div className="ambient-grid"/>
  <svg className="water-ribbons" viewBox="0 0 1600 560" preserveAspectRatio="none"><defs><linearGradient id="crew-water-light" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff" stopOpacity="0"/><stop offset=".45" stopColor="#fff" stopOpacity=".85"/><stop offset="1" stopColor="#b6ecff" stopOpacity=".1"/></linearGradient></defs><path d="M-200 280C100 40 260 550 590 240S1150 80 1800 380"/><path d="M-200 306C100 70 270 580 610 265S1150 95 1800 408"/><path d="M-200 338C100 104 280 590 630 287S1150 120 1800 438"/></svg>
</div>;}
export function LiquidOrb(){return <div className="liquid-orb-scene" aria-hidden="true"><div className="orb-orbit orbit-one"/><div className="orb-orbit orbit-two"/><div className="liquid-orb"><div className="orb-liquid"/><i/><b/></div><span className="orb-spark spark-one"/><span className="orb-spark spark-two"/></div>;}
