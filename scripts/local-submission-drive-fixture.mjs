import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const folderMime = 'application/vnd.google-apps.folder';

export function createSyntheticSubmissionDrive(expectedBytes) {
  const rootId = 'synthetic-root';
  const folders = new Map([[rootId, {id:rootId,name:rootId,parents:[],mimeType:folderMime,trashed:false}]]);
  const files = new Map();
  let serial = 0, copies = 0;
  const md5 = createHash('md5').update(expectedBytes).digest('hex');
  const exists = id => folders.has(id) || files.has(id);
  const drive = {files:{
    generateIds:async ({count})=>{
      assert.equal(count,1);
      return {data:{ids:['synthetic-drive-'+(++serial)]}};
    },
    list:async ({q,pageSize})=>{
      const match=/^'([A-Za-z0-9_-]+)' in parents and name='((?:\\.|[^'\\])*)' and mimeType='application\/vnd\.google-apps\.folder' and trashed=false$/.exec(q);
      assert.ok(match,'Expected a folder lookup under one synthetic parent');
      assert.equal(pageSize,2);
      const [,parentId,escaped]=match;
      assert.ok(folders.has(parentId),'Unknown synthetic parent');
      const name=escaped.replace(/\\(['\\])/g,'$1');
      const matches=[...folders.values()].filter(folder=>folder.name===name && folder.parents.includes(parentId));
      return {data:{files:structuredClone(matches.slice(0,pageSize)),...(matches.length>pageSize?{nextPageToken:'synthetic-next'}:{})}};
    },
    get:async ({fileId})=>{
      const entry=folders.get(fileId)??files.get(fileId);
      if(!entry)throw {code:404};
      return {data:structuredClone(entry)};
    },
    create:async ({requestBody,media})=>{
      const {id,name,mimeType,parents,appProperties}=requestBody;
      assert.match(id,/^synthetic-drive-[1-9][0-9]*$/);
      assert.ok(name && parents?.length===1 && folders.has(parents[0]),'Expected one known synthetic parent');
      if(exists(id))throw {code:409};
      const entry={...requestBody,trashed:false};
      if(mimeType===folderMime){
        assert.equal(media,undefined);
        assert.equal(appProperties?.lkcFolder,createHash('sha256').update(JSON.stringify([parents[0],name])).digest('hex'));
        folders.set(id,entry);
      }else{
        assert.equal(media?.mimeType,mimeType);
        assert.match(appProperties?.lkcTransfer??'',/^[a-f0-9]{64}$/);
        const chunks=[];for await(const chunk of media.body)chunks.push(chunk);
        const bytes=Buffer.concat(chunks);
        assert.deepEqual(bytes,expectedBytes);
        if(exists(id))throw {code:409};
        files.set(id,{...entry,size:String(bytes.length),md5Checksum:md5,createdTime:new Date().toISOString()});
        copies++;
      }
      return drive.files.get({fileId:id});
    },
  }};
  return {drive,files,rootId,copies:()=>copies};
}
