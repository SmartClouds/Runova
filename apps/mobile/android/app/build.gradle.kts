plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val coreDir = rootProject.file("../core")
val generatedBindings = layout.buildDirectory.dir("generated/uniffi")
val hostLibrary = coreDir.resolve("target/debug")
val generatedFonts = layout.buildDirectory.dir("generated/fonts/res")

android {
    namespace = "com.runovahq.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.runovahq.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
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

tasks.matching { it.name.endsWith("Resources") || it.name == "preBuild" }.configureEach {
    if (name != copyFonts.name) dependsOn(copyFonts)
}

val buildHostCore by tasks.registering(Exec::class) {
    workingDir = coreDir
    commandLine("cargo", "build", "--jobs", "2", "-p", "runova-ffi")
}

val generateBindings by tasks.registering(Exec::class) {
    dependsOn(buildHostCore)
    workingDir = coreDir
    commandLine(
        "cargo", "run", "--jobs", "2", "-p", "runova-ffi", "--bin", "uniffi-bindgen", "--",
        "generate", "--library", "target/debug/$hostLibraryFile",
        "--language", "kotlin", "--no-format",
        "--out-dir", generatedBindings.get().asFile.path,
    )
}

// Everything that compiles Kotlin needs the generated bindings first.
tasks.matching { it.name.startsWith("compile") || it.name == "preBuild" }.configureEach {
    if (name != generateBindings.name) dependsOn(generateBindings)
}

/** The core for the phone: arm64 for devices, x86_64 for the emulator. */
val buildAndroidCore by tasks.registering(Exec::class) {
    workingDir = coreDir
    commandLine(
        "cargo", "ndk", "-t", "arm64-v8a", "-t", "x86_64", "-P", "26",
        "-o", project.file("src/main/jniLibs").path,
        "build", "--release", "--jobs", "2", "-p", "runova-ffi",
    )
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("JniLibFolders") }.configureEach {
    dependsOn(buildAndroidCore)
}
