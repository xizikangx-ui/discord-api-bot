package app.yichang.book;
import org.junit.Test;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Base64;
import static org.junit.Assert.*;

public class UpdateManifestTest {
    private static KeyPair keys() throws Exception {KeyPairGenerator generator=KeyPairGenerator.getInstance("RSA");generator.initialize(3072);return generator.generateKeyPair();}
    private static String pem(KeyPair pair){return "-----BEGIN PUBLIC KEY-----\n"+Base64.getMimeEncoder(64,new byte[]{10}).encodeToString(pair.getPublic().getEncoded())+"\n-----END PUBLIC KEY-----";}
    private static JSONObject release() throws Exception {return new JSONObject().put("schema",1).put("version","1.2.0").put("versionCode",3).put("publishedAt","2026-10-18T00:00:00Z").put("notes","验证升级").put("artifacts",new JSONObject().put("android",new JSONObject().put("url","https://github.com/xizikangx-ui/discord-api-bot/releases/download/client-v1.2.0/YichangBook-Android-1.2.0.apk").put("size",100).put("sha256","a".repeat(64)).put("packageName","app.yichang.book").put("certificateSha256","b".repeat(64))));}
    private static String sign(JSONObject release,KeyPair pair) throws Exception {byte[] bytes=release.toString().getBytes(StandardCharsets.UTF_8);Signature signature=Signature.getInstance("SHA256withRSA");signature.initSign(pair.getPrivate());signature.update(bytes);return new JSONObject().put("payload",Base64.getEncoder().encodeToString(bytes)).put("signature",Base64.getEncoder().encodeToString(signature.sign())).toString();}
    @Test public void rsa3072UsesExactBytesAndRejectsWrongKey() throws Exception {KeyPair pair=keys();String envelope=sign(release(),pair);UpdateManifest value=UpdateManifest.verify(envelope,pem(pair));assertEquals("1.2.0",value.version);assertEquals(3,value.versionCode);try{UpdateManifest.verify(envelope,pem(keys()));fail("wrong key accepted");}catch(java.lang.IllegalArgumentException expected){}JSONObject changed=new JSONObject(envelope).put("payload",Base64.getEncoder().encodeToString("{}".getBytes(StandardCharsets.UTF_8)));try{UpdateManifest.verify(changed.toString(),pem(pair));fail("tampered payload accepted");}catch(java.lang.IllegalArgumentException expected){}}
    @Test public void signedMetadataCannotRequestAnotherAppOrHost() throws Exception {KeyPair pair=keys();for(String field:new String[]{"url","packageName","sha256"}){JSONObject value=release();value.getJSONObject("artifacts").getJSONObject("android").put(field,"invalid");try{UpdateManifest.verify(sign(value,pair),pem(pair));fail(field+" accepted");}catch(java.lang.IllegalArgumentException expected){}}}
    @Test public void releaseDownloadKeepsTheFixedRepositoryAndHttpsRedirects() throws Exception {KeyPair pair=keys();UpdateManifest value=UpdateManifest.verify(sign(release(),pair),pem(pair));assertTrue(value.downloadUrl(value.url));assertTrue(value.downloadUrl("https://release-assets.githubusercontent.com/a?token=example"));for(String s:new String[]{"http://objects.githubusercontent.com/a","https://user@objects.githubusercontent.com/a","https://evil.test/a","https://github.com/other/repository/a","file:///data/a"})assertFalse(value.downloadUrl(s));assertFalse(UpdateManifest.artifactUrl(value.url,"1.1.0"));}
    @Test public void installRequiresSameAppNewerVersionAndOriginalCertificate() throws Exception {KeyPair pair=keys();UpdateManifest value=UpdateManifest.verify(sign(release(),pair),pem(pair));String certificate="b".repeat(64);value.validateInstalled("app.yichang.book","1.2.0",3,2,certificate,certificate);for(int mode=0;mode<5;mode++){try{value.validateInstalled(mode==0?"other.app":"app.yichang.book",mode==1?"1.3.0":"1.2.0",mode==2?4:3,mode==3?3:2,certificate,mode==4?"a".repeat(64):certificate);fail("incompatible update accepted: "+mode);}catch(IllegalArgumentException expected){}}}
}
