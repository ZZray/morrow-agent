// Copyright (c) Ray Zhang. A process-lifetime lock, separate from business SQLite transactions.
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,realpathSync,existsSync,statSync,lstatSync} from 'node:fs';
import {dirname,basename,join,resolve} from 'node:path';

export class ServiceOwner {
  readonly instanceId:string=randomUUID();
  readonly filename:string;
  readonly lockIdentity:string;
  #lock:DatabaseSync;
  #closed=false;
  #lockFile:string;
  #lockIdentity?:string;
  #databaseIdentity?:string;
  constructor(filename:string){
    if(filename===':memory:')this.filename=filename;
    else{
      const absolute=resolve(filename);mkdirSync(dirname(absolute),{recursive:true,mode:0o700});
      this.filename=existsSync(absolute)?realpathSync(absolute):join(realpathSync(dirname(absolute)),basename(absolute));
      if(existsSync(this.filename)&&statSync(this.filename).nlink!==1)throw Error('Reach state database must not have hard-link aliases');
      if(existsSync(this.filename))this.#databaseIdentity=this.#identity(this.filename);
    }
    const lockFile=this.filename===':memory:'?':memory:':this.filename+'.owner.sqlite';
    this.#lockFile=lockFile;
    if(lockFile!==':memory:'&&existsSync(lockFile)&&(lstatSync(lockFile).isSymbolicLink()||statSync(lockFile).nlink!==1))throw Error('Reach owner lock must have one unaliased file identity');
    const before=lockFile===':memory:'||!existsSync(lockFile)?undefined:this.#identity(lockFile);
    this.#lock=new DatabaseSync(lockFile);
    try{
      this.#lock.exec('PRAGMA busy_timeout=0;');
      const mode=this.#lock.prepare('PRAGMA journal_mode=DELETE').get()!.journal_mode;
      if(mode!==(lockFile===':memory:'?'memory':'delete'))throw Error('Reach owner lock requires rollback-journal mode');
      this.#lock.exec('BEGIN EXCLUSIVE;');
      if(lockFile!==':memory:'){this.#lockIdentity=this.#identity(lockFile);if(before&&before!==this.#lockIdentity)throw Error('Reach owner lock changed during acquisition');}
      // This connection intentionally holds its transaction for the whole owner lifetime.
      // Its uncommitted contents are never used as proof; the OS/SQLite lock is the proof.
    }catch(error){this.#lock.close();throw Error('Another Reach service owns this state database',{cause:error});}
    this.lockIdentity=createHash('sha256').update(JSON.stringify({protocol:1,path:this.filename,file:this.#lockIdentity??this.instanceId})).digest('hex');
  }
  #identity(path:string){const s=statSync(path,{bigint:true});if(s.nlink!==1n)throw Error('Reach state files must not have hard-link aliases');return String(s.dev)+':'+String(s.ino);}
  bindDatabase(){if(this.filename===':memory:')return;const value=this.#identity(this.filename);if(this.#databaseIdentity&&this.#databaseIdentity!==value)throw Error('Reach state database changed during acquisition');this.#databaseIdentity=value;this.assertCurrent();}
  assertCurrent(){if(this.#closed)throw Error('Reach service owner is closed');if(this.#lockFile!==':memory:'&&(this.#identity(this.#lockFile)!==this.#lockIdentity||this.#identity(this.filename)!==this.#databaseIdentity))throw Error('Reach state or owner lock file identity changed');}
  get closed(){return this.#closed;}
  close(){if(this.#closed)return;try{this.#lock.exec('ROLLBACK');}finally{this.#lock.close();this.#closed=true;}}
}
