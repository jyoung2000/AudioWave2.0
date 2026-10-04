plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "com.nowplaying.player"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.nowplaying.player"
    // youtubedl-android needs 21; 26 is the floor for the audio and notification APIs this uses,
    // and by now it costs almost no reach.
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "1.0.0"
  }

  /*
   * One APK per architecture.
   *
   * The tool libraries carry a Python runtime and an FFmpeg build for every ABI, so a universal APK
   * is several hundred megabytes and most of it is for a processor the phone does not have. Split,
   * each one is a fraction of that. `arm64-v8a` is the one nearly every phone since about 2017
   * wants; the others are here so the odd older device and the emulator are not left out.
   */
  splits {
    abi {
      isEnable = true
      reset()
      include("arm64-v8a", "armeabi-v7a", "x86_64")
      isUniversalApk = false
    }
  }

  buildTypes {
    release {
      // Not minified: the tool libraries reach classes from Python by name, and shrinking them
      // needs keep rules nobody has written. See proguard-rules.pro.
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions { jvmTarget = "17" }

  packaging {
    // The other half of `android.bundle.enableUncompressedNativeLibs=false`: the Python runtime is
    // unpacked from the APK at first run, which only works if it was stored rather than deflated.
    jniLibs { useLegacyPackaging = true }
    resources {
      excludes += setOf("META-INF/*.kotlin_module", "META-INF/DEPENDENCIES")
      // computer.iroh:iroh (the JVM jar under iroh-android) carries desktop builds of the FFI
      // library as resources. Android loads libiroh_ffi.so from iroh-android's jniLibs instead, so
      // these would only be dead weight in the APK.
      excludes += setOf("darwin-*/**", "linux-*/**", "win32-*/**")
    }
  }

  testOptions {
    // The AWSP unit tests are pure JVM; any android.* call they reach by accident should fail loudly
    // rather than return a default, so this stays false.
    unitTests.isReturnDefaultValues = false
  }

  lint {
    abortOnError = false
  }
}

/*
 * The player is copied in, not built here.
 *
 * `NP_BASE_PATH=/assets/app/ pnpm build:player` produces `music-player/dist`; CI copies it to `app/src/main/assets/app`
 * before assembling. Checking for it at configuration time turns "the app opens to a blank screen"
 * — which is a miserable thing to debug on a phone — into a build failure that says what to run.
 */
val playerAssets = layout.projectDirectory.dir("src/main/assets/app")

/*
 * Where the app serves the player from, read from MainActivity's START_URL rather than written twice:
 * `.../assets/app/index.html` means the player must have been built with the base `/assets/app/`.
 */
val servedBase: String = run {
  val source = layout.projectDirectory.file("src/main/java/com/nowplaying/player/MainActivity.kt").asFile.readText()
  val start = Regex("""START_URL\s*=\s*"\${'$'}ASSET_ORIGIN(/[^"]*/)index\.html"""").find(source)
    ?: error("MainActivity.START_URL no longer has the shape \"\$ASSET_ORIGIN/<base>/index.html\"; update checkPlayerAssets with it.")
  start.groupValues[1]
}

tasks.register("checkPlayerAssets") {
  doLast {
    val advice =
      "Build it for the path the app serves it from, and copy it in:\n" +
        "  NP_BASE_PATH=$servedBase pnpm build:player   (in Git Bash: MSYS_NO_PATHCONV=1 NP_BASE_PATH=$servedBase pnpm build:player)\n" +
        "  rm -rf android/app/src/main/assets/app && cp -R music-player/dist android/app/src/main/assets/app"
    val index = playerAssets.file("index.html").asFile
    check(index.exists()) { "No player in ${playerAssets.asFile.path}.\n$advice" }
    // A player built for another base still produces a green build and an app that opens to a blank
    // screen (Hermes, 2026-10-04): every script it asks for is somewhere the app does not serve. The
    // built page names its entry script; it must sit under the base the app serves from. Git Bash
    // also rewrites `/assets/app/` into `/Program Files/Git/assets/app/` unless told not to.
    val html = index.readText()
    val entries = Regex("""<script[^>]*\ssrc="([^"]*/index-[^"/]*\.js)"""").findAll(html).map { it.groupValues[1] }.toList()
    check(entries.isNotEmpty()) { "The player in ${playerAssets.asFile.path} names no entry script; it is not a player build.\n$advice" }
    val wrong = entries.filterNot { it.startsWith("${servedBase}assets/") }
    check(wrong.isEmpty()) {
      "The player in ${playerAssets.asFile.path} was built for another base path: it asks for ${wrong.joinToString()} " +
        "but the app serves it from $servedBase, so it would open to a blank screen.\n$advice"
    }
  }
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
  dependsOn("checkPlayerAssets")
}

dependencies {
  // Local JVM tests for the parts of the app that are ordinary Kotlin: which hosts a fetch may
  // name, and which addresses point back inside a network. No device, no emulator, seconds to run.
  testImplementation("junit:junit:4.13.2")
  // android.jar's org.json is a stub on the JVM; the AWSP frame tests need the real one.
  testImplementation("org.json:json:20240303")

  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
  // WebViewAssetLoader lives here. It is what lets the player run on a real https origin rather
  // than file://, which is the difference between having IndexedDB, a service worker and Web Audio
  // and having none of them.
  implementation("androidx.webkit:webkit:1.12.1")

  implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
  implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")

  // AWSP (docs/AWSP.md): streaming from the Windows companion. iroh's Kotlin bindings carry the
  // QUIC connection (libiroh_ffi.so per ABI, via JNA); Media3 plays the bytes in a
  // MediaSessionService. 1.9.x is the newest Media3 line whose AARs accept compileSdk 35.
  implementation("computer.iroh:iroh-android:1.1.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
  implementation("androidx.media3:media3-exoplayer:1.9.3")
  implementation("androidx.media3:media3-session:1.9.3")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
}
