package com.nowplaying.player.awsp

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The client's identity (§1): its iroh secret key and the PC it paired with, kept in app-private
 * files **encrypted with an AES-256-GCM key that lives in the Android Keystore** and cannot be
 * exported. The raw iroh key is never written in the clear; it exists decrypted only in memory,
 * long enough to bind the endpoint.
 *
 * File layout (`files/awsp/identity.bin`): `version (1) | iv length (1) | iv | ciphertext+tag`,
 * with a fixed associated-data string so a blob from another purpose cannot be swapped in.
 * `android:allowBackup="false"` keeps it off backups; a Keystore key would not survive a restore
 * to another device anyway.
 */
class IdentityStore(context: Context) {
  data class Paired(val ticket: String, val serverName: String)

  class Identity(val secretKey: ByteArray, val paired: Paired?)

  private val file = File(context.filesDir, "awsp/identity.bin")

  /** Load the identity, or create one with [generate] (a fresh iroh secret key) and save it. */
  fun loadOrCreate(generate: () -> ByteArray): Identity {
    if (file.exists()) {
      try {
        return decode(decrypt(file.readBytes()))
      } catch (e: Exception) {
        // The Keystore key is gone (cleared app data, a restore) or the file is damaged. The old
        // identity is unrecoverable by design: start a new one, which means pairing again.
        Log.w(AwspClient.TAG, "awsp identity unreadable, creating a new one: $e")
      }
    }
    val id = Identity(generate(), null)
    save(id)
    return id
  }

  fun save(identity: Identity) {
    val json = JSONObject().put("secret_key", Base64.encodeToString(identity.secretKey, Base64.NO_WRAP))
    identity.paired?.let { json.put("ticket", it.ticket).put("server_name", it.serverName) }
    val plain = json.toString().toByteArray(Charsets.UTF_8)
    try {
      val blob = encrypt(plain)
      file.parentFile?.mkdirs()
      val tmp = File(file.parentFile, file.name + ".tmp")
      tmp.writeBytes(blob)
      if (!tmp.renameTo(file)) {
        file.delete()
        tmp.renameTo(file)
      }
    } finally {
      plain.fill(0)
    }
  }

  private fun decode(plain: ByteArray): Identity = try {
    val o = JSONObject(String(plain, Charsets.UTF_8))
    val key = Base64.decode(o.getString("secret_key"), Base64.NO_WRAP)
    require(key.size == 32) { "secret key must be 32 bytes" }
    val paired = if (o.has("ticket")) Paired(o.getString("ticket"), o.optString("server_name", "PC")) else null
    Identity(key, paired)
  } finally {
    plain.fill(0)
  }

  private fun keystoreKey(): SecretKey {
    val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return gen.generateKey()
  }

  private fun encrypt(plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, keystoreKey()) // the Keystore picks a fresh random IV
    cipher.updateAAD(AAD)
    val ct = cipher.doFinal(plain)
    val iv = cipher.iv
    return byteArrayOf(VERSION, iv.size.toByte()) + iv + ct
  }

  private fun decrypt(blob: ByteArray): ByteArray {
    require(blob.size > 2 && blob[0] == VERSION) { "unknown identity format" }
    val ivLen = blob[1].toInt() and 0xff
    val iv = blob.copyOfRange(2, 2 + ivLen)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, iv))
    cipher.updateAAD(AAD)
    return cipher.doFinal(blob, 2 + ivLen, blob.size - 2 - ivLen)
  }

  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val ALIAS = "awsp-identity"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val VERSION: Byte = 1
    val AAD = "awsp-identity-v1".toByteArray()
  }
}
