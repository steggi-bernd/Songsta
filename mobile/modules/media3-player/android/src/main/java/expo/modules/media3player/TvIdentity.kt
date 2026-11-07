package expo.modules.media3player

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.PublicKey
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPublicKey
import java.util.Date
import javax.net.ssl.KeyManager
import javax.net.ssl.X509ExtendedKeyManager
import javax.security.auth.x500.X500Principal

/**
 * What this app shows a TV's remote control: its own key and a certificate for it, made once. The key
 * stays in Android's keystore and never leaves it; the TV remembers the certificate after the pairing.
 */
internal object TvIdentity {
  private const val ALIAS = "songsta-tv-remote"
  private const val TEN_YEARS_MS = 10L * 365 * 24 * 60 * 60 * 1000

  private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  @Synchronized
  private fun entry(): KeyStore.PrivateKeyEntry {
    val keys = store()
    if (!keys.containsAlias(ALIAS)) {
      val now = System.currentTimeMillis()
      val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(2048)
        .setCertificateSubject(X500Principal("CN=Songsta"))
        .setCertificateSerialNumber(BigInteger.valueOf(1000))
        .setCertificateNotBefore(Date(now - 24 * 60 * 60 * 1000))
        .setCertificateNotAfter(Date(now + TEN_YEARS_MS))
        .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA384, KeyProperties.DIGEST_SHA512)
        .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1, KeyProperties.SIGNATURE_PADDING_RSA_PSS)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE, KeyProperties.ENCRYPTION_PADDING_RSA_PKCS1)
        .setRandomizedEncryptionRequired(false)
        .build()
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
    }
    return keys.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
  }

  fun partsOf(key: PublicKey): Map<String, String>? {
    val rsa = key as? RSAPublicKey ?: return null
    return mapOf("modulus" to rsa.modulus.toString(16), "exponent" to rsa.publicExponent.toString(16))
  }

  fun ownKey(): Map<String, String>? = partsOf(entry().certificate.publicKey)

  fun keyManagers(): Array<KeyManager> {
    val own = entry()
    val chain = arrayOf(own.certificate as X509Certificate)
    return arrayOf(object : X509ExtendedKeyManager() {
      override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf(ALIAS)
      override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = ALIAS
      override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?) = null
      override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?) = null
      override fun getCertificateChain(alias: String?) = chain
      override fun getPrivateKey(alias: String?): PrivateKey = own.privateKey
    })
  }
}
