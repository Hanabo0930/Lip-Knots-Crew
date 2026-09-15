import {getFirestore,connectFirestoreEmulator,type Firestore} from "firebase/firestore";
import {firebaseApp} from "./firebase";
import {useFirebaseEmulators} from "./firebase-config";

let database:Firestore|null=null;
export function getAdminFirestore():Firestore{
  if(!firebaseApp)throw new Error("データベースに接続できません。");
  if(!database){
    const candidate=getFirestore(firebaseApp);
    if(useFirebaseEmulators)connectFirestoreEmulator(candidate,"127.0.0.1",8080);
    database=candidate;
  }
  return database;
}
