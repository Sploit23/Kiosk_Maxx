# Build script for Fujifilm ASK-400 Sidecar
# Requirements: JDK 8+ (uses JDK 24 at C:\Program Files\Java\jdk-24)

$ErrorActionPreference = "Stop"

$JAVA_HOME = "C:\Program Files\Java\jdk-24"
$JAVAC = "$JAVA_HOME\bin\javac.exe"
$JAR = "$JAVA_HOME\bin\jar.exe"
$SRC_DIR = "src"
$BUILD_DIR = "build"
$CLASSES_DIR = "$BUILD_DIR\classes"
$RESOURCES_DIR = "resources"
$OUTPUT_JAR = "$BUILD_DIR\sidecar-ask400.jar"
$MAIN_CLASS = "com.fotoagora.sidecar.SidecarMain"

Write-Host "=== Build Sidecar ASK-400 ===" -ForegroundColor Cyan

# Step 1: Clean
if (Test-Path $BUILD_DIR) {
    Remove-Item -Recurse -Force "$CLASSES_DIR\*" -ErrorAction SilentlyContinue
} else {
    New-Item -ItemType Directory -Path $CLASSES_DIR -Force | Out-Null
}

# Step 2: Find all .java files
$javaFiles = Get-ChildItem -Recurse -Filter "*.java" -Path $SRC_DIR | ForEach-Object { $_.FullName }
Write-Host "Found $($javaFiles.Count) Java files" -ForegroundColor Yellow

# Step 3: Compile
Write-Host "Compiling with --release 8..." -ForegroundColor Yellow
$javacArgs = @(
    "--release", "8",
    "-d", $CLASSES_DIR,
    "-sourcepath", $SRC_DIR
) + $javaFiles

& $JAVAC $javacArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "Compilation FAILED!" -ForegroundColor Red
    exit 1
}
Write-Host "Compilation OK" -ForegroundColor Green

# Step 4: Copy resources (DLLs) to classes dir
Write-Host "Copying native libraries..." -ForegroundColor Yellow
$targetNativeDir = "$CLASSES_DIR\native_libs\picgo-ask400"
New-Item -ItemType Directory -Path $targetNativeDir -Force | Out-Null
Copy-Item "$RESOURCES_DIR\native_libs\picgo-ask400\*.dll" -Destination $targetNativeDir

# Step 5: Create manifest
$manifestContent = @"
Manifest-Version: 1.0
Main-Class: $MAIN_CLASS
Created-By: Sidecar Build

"@
$manifestFile = "$BUILD_DIR\MANIFEST.MF"
Set-Content -Path $manifestFile -Value $manifestContent -Encoding ASCII

# Step 6: Create JAR
Write-Host "Creating JAR..." -ForegroundColor Yellow
& $JAR -cfm $OUTPUT_JAR $manifestFile -C $CLASSES_DIR .
if ($LASTEXITCODE -ne 0) {
    Write-Host "JAR creation FAILED!" -ForegroundColor Red
    exit 1
}

Write-Host "JAR created: $OUTPUT_JAR" -ForegroundColor Green

# Step 7: Show size
$jarInfo = Get-Item $OUTPUT_JAR
Write-Host "Size: $([math]::Round($jarInfo.Length / 1024)) KB" -ForegroundColor Green
Write-Host ""
Write-Host "To run:" -ForegroundColor Cyan
Write-Host "  `"C:\Program Files (x86)\Eclipse Adoptium\jre-8.0.472.8-hotspot\bin\java.exe`" -jar $OUTPUT_JAR" -ForegroundColor White
