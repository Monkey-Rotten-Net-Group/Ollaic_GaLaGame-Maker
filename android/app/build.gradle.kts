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
}

dependencies {
  add("kotlinCompilerPluginClasspath", "androidx.compose.compiler:compiler:1.5.15")
  implementation(platform("androidx.compose:compose-bom:2024.06.00"))
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-extended")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
  debugImplementation("androidx.compose.ui:ui-tooling")
}
