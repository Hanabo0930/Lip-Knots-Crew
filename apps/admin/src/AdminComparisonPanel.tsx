import type {ResubmissionComparison} from "./App";
export default function AdminComparisonPanel({comparison,closeComparison}:{comparison:ResubmissionComparison;closeComparison:()=>void}){return (          <div className="comparison-panel">
            <div className="comparison-head"><div><h3>再送画像の比較</h3><small>{comparison.request.reasons.join(" / ")}</small></div><button className="ghost compact" onClick={()=>closeComparison()}>閉じる</button></div>
            <div className="comparison-grid">
              <figure><figcaption>元画像</figcaption>{comparison.source?.previewUrl ? <img src={comparison.source.previewUrl} alt="元画像" /> : <div className="pdf-preview">元画像なし</div>}<small>{comparison.source?.driveName ?? ""}</small></figure>
              <figure><figcaption>再送画像</figcaption>{comparison.replacements[0]?.previewUrl ? <img src={comparison.replacements[0].previewUrl!} alt="再送画像" /> : <div className="pdf-preview">再送待ち</div>}<small>{comparison.replacements[0]?.driveName ?? ""}</small></figure>
            </div>
          </div>);}
