import {getStorage,connectStorageEmulator,uploadBytesResumable as startUpload,type FirebaseStorage} from "firebase/storage";
import {auth,firebaseApp} from "./firebase";
import {useFirebaseEmulators} from "./firebase-config";
export {ref} from "firebase/storage";
let storage:FirebaseStorage|null=null;
export function getClientStorage():FirebaseStorage{
  if(!firebaseApp)throw new Error("送信サービスの接続準備を確認できません。");
  if(!storage){const candidate=getStorage(firebaseApp);if(useFirebaseEmulators)connectStorageEmulator(candidate,"127.0.0.1",9199);storage=candidate;}
  return storage;
}
export function uploadBytesResumable(...args:Parameters<typeof startUpload>):ReturnType<typeof startUpload>{
  const [target]=args;
  const owner=auth?.currentUser;
  if(!auth||!owner||target.fullPath.split("/")[2]!==owner.uid){
    throw new Error("ログイン中の本人と送信先を照合できません。");
  }
  const task=startUpload(...args);
  // Stop SDK transfers already in flight when the device changes its signed-in account.
  const unsubscribe=auth.onAuthStateChanged(current=>{if(current?.uid!==owner.uid)task.cancel();});
  void task.then(unsubscribe,unsubscribe);
  return task;
}
