'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{Pool}=require('pg'),S=require('../src/web/security');
test('linked-map permission fences: isolated real PostgreSQL HTTP transactions',{skip:!process.env.RPG_TEST_DATABASE_URL},async t=>{
 const suffix=crypto.randomBytes(6).toString('hex'),names=['web_test_map_acl_'+suffix,'web_test_map_acl_content_'+suffix,'rpg_test_map_acl_'+suffix],pool=new Pool({connectionString:process.env.RPG_TEST_DATABASE_URL,max:5,connectionTimeoutMillis:5000,statement_timeout:10000}),key=crypto.randomBytes(32).toString('base64'),crypt=S.codec(key),gameCrypt=S.rpgCodec(key),repo=require('../src/web/repository').createRepository(pool,crypt,{schema:names[0]}),content=require('../src/web/repository').createRepository(pool,crypt,{schema:names[1]}),database=require('../src/rpg/postgres').createPostgres({pool,schema:names[2],...gameCrypt});let app;
 try{await repo.init();await content.init();const h=await require('./helpers/chat-website.cjs').launch({pool,repo,content,crypt,database,onApp:a=>app=a});await require('./web-map-permissions.test').cases(t,h);}
 finally{await app?.stop();for(const name of names){assert.match(name,/^(web|rpg)_test_map_acl_[a-z0-9_]+$/);await pool.query('DROP SCHEMA IF EXISTS "'+name+'" CASCADE');}await database.close();}
});
