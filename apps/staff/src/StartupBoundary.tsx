import {Component,type ReactNode} from "react";

export class DeviceStorageError extends Error {}

export default class StartupBoundary extends Component<{children:ReactNode},{error:Error|null}>{
  state:{error:Error|null}={error:null};
  static getDerivedStateFromError(error:unknown){return {error:error instanceof Error?error:new Error(String(error))};}
  render(){
    if(!this.state.error)return this.props.children;
    const storage=this.state.error instanceof DeviceStorageError;
    return <main className="login-shell"><section className="login-card" role="alert">
      <h1>{storage?"端末情報を保存できません":"画面を開けませんでした"}</h1>
      <p>{storage?"ブラウザーの設定で、このサイトのデータ保存を許可してから再試行してください。":"もう一度お試しください。繰り返す場合は管理者へ連絡してください。"}</p>
      <button onClick={()=>this.setState({error:null})}>もう一度試す</button>
    </section></main>;
  }
}
