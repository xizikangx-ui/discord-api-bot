package app.yichang.book;

import org.json.JSONObject;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

/** Verifies the exact signed bytes before parsing any download instructions. */
public final class UpdateManifest {
    public static final String ENDPOINT="https://yichang.up.railway.app/api/web/v1/client-release?platform=android";
    public final String version,notes,url,sha256,certificateSha256,packageName;
    public final long versionCode,size;
    private UpdateManifest(JSONObject value) throws Exception {
        require(value.getInt("schema")==1,"更新清单版本无效。");
        version=value.getString("version");require(version.matches("[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}"),"客户端版本无效。");
        versionCode=value.getLong("versionCode");require(value.get("versionCode") instanceof Number&&value.getDouble("versionCode")==versionCode&&versionCode>0&&versionCode<=Integer.MAX_VALUE,"安卓版本编号无效。");
        notes=value.getString("notes");require(notes.length()<=8000&&value.getString("publishedAt").length()<80,"更新说明无效。");java.time.Instant.parse(value.getString("publishedAt"));
        JSONObject artifact=value.getJSONObject("artifacts").getJSONObject("android");
        url=artifact.getString("url");require(artifactUrl(url,version),"更新文件地址无效。");
        size=artifact.getLong("size");require(size>0&&size<=128L*1024*1024,"更新文件大小无效。");
        sha256=artifact.getString("sha256");certificateSha256=artifact.getString("certificateSha256");packageName=artifact.getString("packageName");
        require(sha256.matches("[a-f0-9]{64}")&&certificateSha256.matches("[a-f0-9]{64}")&&packageName.equals("app.yichang.book"),"安卓更新校验信息无效。");
    }
    public static UpdateManifest verify(String envelope,String pem) throws Exception {
        require(envelope.length()<=384*1024,"更新清单超过限制。");JSONObject e=new JSONObject(envelope);
        String payload=e.getString("payload"),encodedSignature=e.getString("signature");require(payload.length()<=256*1024&&encodedSignature.length()<1024,"更新清单无效。");
        byte[] data=Base64.getDecoder().decode(payload),sig=Base64.getDecoder().decode(encodedSignature);
        require(Base64.getEncoder().encodeToString(data).equals(payload)&&Base64.getEncoder().encodeToString(sig).equals(encodedSignature),"更新清单编码无效。");
        String base=pem.replace("-----BEGIN PUBLIC KEY-----","").replace("-----END PUBLIC KEY-----","").replaceAll("\\s","");
        RSAPublicKey key=(RSAPublicKey)KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(base)));
        require(key.getModulus().bitLength()>=3072,"更新公钥不符合要求。");Signature verifier=Signature.getInstance("SHA256withRSA");verifier.initVerify(key);verifier.update(data);
        require(verifier.verify(sig),"更新清单签名校验失败，保留当前版本。");
        return new UpdateManifest(new JSONObject(new String(data,StandardCharsets.UTF_8)));
    }
    public static boolean artifactUrl(String value,String version){try{URI u=new URI(value);String prefix="/xizikangx-ui/discord-api-bot/releases/download/client-v"+version+"/";return "https".equals(u.getScheme())&&"github.com".equals(u.getHost())&&u.getUserInfo()==null&&u.getPort()==-1&&u.getQuery()==null&&u.getFragment()==null&&u.getRawPath().startsWith(prefix)&&u.getRawPath().substring(prefix.length()).matches("[A-Za-z0-9][A-Za-z0-9._-]{1,150}\\.apk");}catch(Exception e){return false;}}
    public boolean downloadUrl(String value){try{URI u=new URI(value);if(!"https".equals(u.getScheme())||u.getUserInfo()!=null||u.getPort()!=-1)return false;if("github.com".equals(u.getHost()))return value.equals(url);return "release-assets.githubusercontent.com".equals(u.getHost())||"objects.githubusercontent.com".equals(u.getHost())||"github-releases.githubusercontent.com".equals(u.getHost());}catch(Exception e){return false;}}
    public static String digest(byte[] bytes) throws Exception {return hex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    public void validateInstalled(String archivePackage,String archiveVersion,long archiveCode,long installedCode,String installedCertificate,String archiveCertificate){require(packageName.equals(archivePackage)&&version.equals(archiveVersion)&&archiveCode==versionCode&&archiveCode>installedCode,"此更新不适用于当前应用版本。");require(installedCertificate.equals(archiveCertificate)&&archiveCertificate.equals(certificateSha256),"新版与已安装应用的签名不同，未进行安装。");}
    public static String hex(byte[] bytes){StringBuilder s=new StringBuilder();for(byte b:bytes)s.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return s.toString();}
    public static void require(boolean value,String message){if(!value)throw new IllegalArgumentException(message);}
}
