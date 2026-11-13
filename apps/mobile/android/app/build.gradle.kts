plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val coreDir = rootProject.file("../core")
val generatedBindings = layout.buildDirectory.dir("generated/uniffi")
// Cargo's output folder. CI points CARGO_TARGET_DIR at the runner's tool cache, so the core and
// its dependencies are not built from scratch every run.
val coreTarget = System.getenv("CARGO_TARGET_DIR")?.takeIf { it.isNotBlank() }?.let { file(it) }
    ?: coreDir.resolve("target")
val hostLibrary = coreTarget.resolve("debug")
val generatedFonts = layout.buildDirectory.dir("generated/fonts/res")

android {
    namespace = "com.runovahq.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.runovahq.app"
        minSdk = 26
        targetSdk = 36
        versionCode = (findProperty("appVersionCode") as String?)?.toInt() ?: 1
        versionName = (findProperty("appVersionName") as String?) ?: "0.1.0"

        // Empty until a Firebase project exists. The app then simply asks for no push token.
        for ((field, variable) in listOf(
            "FIREBASE_API_KEY" to "RUNOVA_FIREBASE_API_KEY",
            "FIREBASE_APP_ID" to "RUNOVA_FIREBASE_APP_ID",
            "FIREBASE_PROJECT_ID" to "RUNOVA_FIREBASE_PROJECT_ID",
            "FIREBASE_SENDER_ID" to "RUNOVA_FIREBASE_SENDER_ID",
        )) {
            buildConfigField("String", field, "\"${System.getenv(variable).orEmpty()}\"")
        }
    }

    // Only a release build in CD has these, see docs/mobile/release.md.
    System.getenv("RUNOVA_ANDROID_KEYSTORE")?.let { keystore ->
        signingConfigs.create("release") {
            storeFile = file(keystore)
            storePassword = System.getenv("RUNOVA_ANDROID_STORE_PASSWORD")
            keyAlias = System.getenv("RUNOVA_ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("RUNOVA_ANDROID_KEY_PASSWORD")
        }
    }

    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    sourceSets {
        getByName("main") {
            kotlin.directories.add(generatedBindings.get().asFile.path)
            res.directories.add(generatedFonts.get().asFile.path)
        }
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            // JVM tests load the real core, built for this computer.
            it.systemProperty("jna.library.path", hostLibrary.path)
            // Screenshots are compared against the committed ones, or rewritten with -Precord.
            it.systemProperty(
                "roborazzi.test.compare",
                (!project.hasProperty("record")).toString(),
            )
            it.systemProperty("roborazzi.test.record", project.hasProperty("record").toString())
            it.systemProperty("roborazzi.test.verify", (!project.hasProperty("record")).toString())
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.camera:camera-camera2:1.5.0")
    implementation("androidx.camera:camera-lifecycle:1.5.0")
    implementation("androidx.camera:camera-view:1.5.0")
    implementation("com.google.zxing:core:3.5.3")
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    implementation("net.java.dev.jna:jna:5.17.0@aar")

    testImplementation(composeBom)
    testImplementation("net.java.dev.jna:jna:5.17.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("org.robolectric:robolectric:4.16")
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.78.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.78.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

val hostLibraryFile = System.mapLibraryName("runova_ffi")

/** One set of fonts for both apps, named as Android's resources must be. */
val copyFonts by tasks.registering(Copy::class) {
    from(rootProject.file("../design/fonts")) { include("*.ttf") }
    into(generatedFonts.map { it.dir("font") })
    rename("Inter.ttf", "inter.ttf")
    rename("JetBrainsMono.ttf", "jetbrains_mono.ttf")
    rename("FontAwesomeSolid.ttf", "fontawesome_solid.ttf")
}

/** The logos, from the one copy both apps use. */
val copyBrand by tasks.registering(Copy::class) {
    from(rootProject.file("../design/brand"))
    into(generatedFonts.map { it.dir("drawable-nodpi") })
}

tasks.matching { it.name.endsWith("Resources") || it.name == "preBuild" }.configureEach {
    if (name != copyFonts.name && name != copyBrand.name) dependsOn(copyFonts, copyBrand)
}

val buildHostCore by tasks.registering(Exec::class) {
    workingDir = coreDir
    commandLine("cargo", "build", "--jobs", "2", "-p", "runova-ffi")
}

val generateBindings by tasks.registering(Exec::class) {
    dependsOn(buildHostCore)
    workingDir = coreDir
    commandLine(
        "cargo", "run", "--jobs", "2", "-p", "runova-bindgen", "--",
        "generate", "--library", hostLibrary.resolve(hostLibraryFile).path,
        "--language", "kotlin", "--no-format",
        "--out-dir", generatedBindings.get().asFile.path,
    )
}

// Everything that compiles Kotlin needs the generated bindings first.
tasks.matching { it.name.startsWith("compile") || it.name == "preBuild" }.configureEach {
    if (name != generateBindings.name) dependsOn(generateBindings)
}

/**
 * The core for the phone: arm64 for devices, x86_64 for the emulator. CI builds the app only to
 * test it, so it passes -PcoreAbis=x86_64 -PcoreProfile=ci: one ABI, without the release profile's
 * LTO pass. Two ABIs with that pass, on top of the host build, did not fit in the job's 40 minutes.
 */
val coreAbis = ((findProperty("coreAbis") as String?) ?: "arm64-v8a,x86_64").split(",").map { it.trim() }
val coreProfile = (findProperty("coreProfile") as String?) ?: "release"

val buildAndroidCore by tasks.registering(Exec::class) {
    workingDir = coreDir
    commandLine(
        listOf("cargo", "ndk") + coreAbis.flatMap { listOf("-t", it) } + listOf(
            "-P", "26",
            "-o", project.file("src/main/jniLibs").path,
            "build", "--profile", coreProfile, "--jobs", "2", "-p", "runova-ffi",
        ),
    )
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("JniLibFolders") }.configureEach {
    dependsOn(buildAndroidCore)
}
