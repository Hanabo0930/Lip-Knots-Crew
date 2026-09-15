export function demoPreview(label:string,color:string){
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480"><rect width="100%" height="100%" fill="${color}"/><rect x="40" y="40" width="640" height="400" rx="24" fill="white" stroke="#d9c8ce"/><text x="360" y="220" text-anchor="middle" font-size="36" fill="#5f4b44" font-family="sans-serif">${label}</text><text x="360" y="270" text-anchor="middle" font-size="18" fill="#9b7e87" font-family="sans-serif">営業デモ用プレビュー</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
