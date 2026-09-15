import {getStorage,connectStorageEmulator,type FirebaseStorage} from "firebase/storage";
import {firebaseApp} from "./firebase";
import {useFirebaseEmulators} from "./firebase-config";
export {ref,uploadBytesResumable} from "firebase/storage";
let storage:FirebaseStorage|null=null;
export function getClientStorage():FirebaseStorage{
  if(!firebaseApp)throw new Error("送信サービスの接続準備を確認できません。");
  if(!storage){const candidate=getStorage(firebaseApp);if(useFirebaseEmulators)connectStorageEmulator(candidate,"127.0.0.1",9199);storage=candidate;}
  return storage;
}