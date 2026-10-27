plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "com.ollaic.galagame_maker"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.ollaic.galagame_maker"
    minSdk = 24
    targetSdk = 36
    versionCode = 1000
    versionName = "0.1.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    ndk { abiFilters += providers.gradleProperty("ollaicAbis").orElse("arm64-v8a").get().split(",") }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
  }
  kotlinOptions { jvmTarget = "1.8" }
  buildFeatures {
    buildConfig = true
    compose = true
  }
  composeOptions { kotlinCompilerExtensionVersion = "1.5.15" }
  androidResources { ignoreAssetsPattern = "!.svn:!.git:!CVS:!thumbs.db:!picasa.ini:!*~" }
  sourceSets.getByName("main") {
    java.srcDir(layout.buildDirectory.dir("generated/ollaic-core/kotlin"))
    jniLibs.srcDir(layout.buildDirectory.dir("generated/ollaic-core/jniLibs"))
  }
  sourceSets.getByName("androidTest").assets.srcDir(rootProject.projectDir.parentFile.parentFile.resolve("crates/ollaic-core/tests/fixtures"))
}

val buildNativeCore by tasks.registering(Exec::class) {
  val repository = rootProject.projectDir.parentFile.parentFile
  val generated = layout.buildDirectory.dir("generated/ollaic-core")
  workingDir(repository)
  environment("ANDROID_HOME", androidComponents.sdkComponents.sdkDirectory.get().asFile.absolutePath)
  commandLine("bash", "scripts/build-native-core.sh", generated.get().asFile.absolutePath,
    providers.gradleProperty("ollaicAbis").orElse("arm64-v8a").get())
  inputs.files(project.fileTree(repository.resolve("crates")) {
    include("*/src/**", "*/Cargo.toml", "*/uniffi.toml", "*/build.rs", "*/webgal-version.txt")
  })
  inputs.files(repository.resolve("Cargo.toml"), repository.resolve("Cargo.lock"), repository.resolve("scripts/build-native-core.sh"))
  inputs.property("abis", providers.gradleProperty("ollaicAbis").orElse("arm64-v8a"))
  outputs.dir(generated)
}
tasks.named("preBuild") { dependsOn(buildNativeCore) }

dependencies {
  implementation("net.java.dev.jna:jna:5.17.0@aar")
  add("kotlinCompilerPluginClasspath", "androidx.compose.compiler:compiler:1.5.15")
  implementation(platform("androidx.compose:compose-bom:2024.06.00"))
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-extended")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
  implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
  implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
  debugImplementation("androidx.compose.ui:ui-tooling")
  debugImplementation("androidx.compose.ui:ui-test-manifest")
  testImplementation("junit:junit:4.13.2")
  androidTestImplementation("androidx.test.ext:junit:1.3.0")
  androidTestImplementation("androidx.test:runner:1.7.0")
  // Older Espresso uses InputManager reflection removed from recent Android versions.
  androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
  androidTestImplementation(platform("androidx.compose:compose-bom:2024.06.00"))
  androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
