# Compilar la billetera "Mi Bóveda" (APK y EXE)

> Billetera por Erleo · Leonardo Noel Salazar Mendoza · "Mi Bóveda + Cerebro"

Este guion explica cómo generar los instalables de la billetera en cada sistema.
Todos los archivos de salida quedan en `build/app/outputs/`.

## Requisitos previos (cualquier sistema)

1. **Flutter stable** (probado con 3.41.9).
2. **Node.js 22+** solo es para el Cerebro (el backend), no para la billetera.
3. Una vez clonado el proyecto, en su raíz:

```bash
flutter pub get
```

> El proyecto ya tiene habilitadas las carpetas `android/`, `windows/`, `linux/`,
> `macos/` y las dependencias de escritorio necesarias. No falta nada de código.

---

## 🟢 ANDROID (.apk)

### En Linux o Windows

```bash
flutter build apk --debug      # rápido, para probar
flutter build apk --release   # definitiva (optimizada y más pequeña)
```

**Salida:** `build/app/outputs/flutter-apk/app-debug.apk` (o `app-release.apk`)

> Nota: en una máquina con poca RAM conviene dar más memoria a Gradle antes:
> edita `android/gradle.properties` y pon:
> `org.gradle.jvmargs=-Xmx3g`
> y
> `android.enableJetifier=false`
> (ya está así en este proyecto; no lo vuelvas a activar si no es necesario).

**Nota de instalación en emulador/container (WayDroid):**
```bash
adb connect <IP>:5555
adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

---

## 🟦 WINDOWS (.exe)

> ⚠️ **Solo se compila en una PC con Windows.** Flutter *no* puede generar el
> .exe desde Linux (no hay cross-compilación para escritorio Windows).

### En tu PC Windows

1. Instala **Flutter stable** y asegúrate de `flutter doctor` no marque errores
   en la sección "Windows Desktop".
   - Suele pedir: **Visual Studio 2022** con la carga de trabajo
     "Desarrollo para escritorio con C++", y las **Herramientas de desarrollo
     de C++**.
2. En la raíz del proyecto:

```powershell
flutter pub get
flutter build windows --release
```

3. **Salida del .exe:**
   ```
   build/windows/x64/runner/Release/
   ```
   Ahí está el ejecutable (`MiBoveda.exe`, según el nombre del runner). Para
   distribuirlo: copia **toda la carpeta `Release/`** (incluye las .dll y datos),
   o envíala comprimida en un .zip.

---

## 🟩 LINUX (appimage / binario)

```bash
flutter build linux --release
```

**Salida:** `build/linux/x64/release/bundle/`
(contiene el binario y las librerías; se puede empaquetar con AppImage/`linuxdeploy`).

---

## 🟪 macOS (.app / .dmg)

En una Mac con Xcode:

```bash
flutter build macos --release
```

**Salida:** `build/macos/Build/Products/Release/` (una `.app`; puedes empaquetar .dmg con `create-dmg`).

---

## Cómo conectar la billetera al Cerebro

La billetera se conecta al Cerebro configurando la **URL del servidor** en los
ajustes de la app. En pruebas locales el Cerebro corre en `http://localhost:8787`
(solo para desarrollo); para producción usa la URL pública (ej. Render):
`https://miboveda-cerebro.onrender.com`

- La app autentica con un **device token** que se registra solo la primera vez.
- El Cerebro expone `/api/v1/config`, `/api/v1/orders/check-liquidity` y
  `/api/v1/balances` para que la app compruebe saldos y liquidez en vivo.

---

## Solución de problemas

| Síntoma | Causa / solución |
|---|---|
| `Java heap space` al compilar APK | Aumentar `-Xmx` en `android/gradle.properties` y asegurar `android.enableJetifier=false`. |
| `flutter build windows` bloqueado | Falta Visual Studio 2022 + herramientas C++ en Windows. Corre `flutter doctor`. |
| No veo la pestaña Ganancias/Mercado | Es del **panel del Cerebro** (en `public/`), no de la billetera. Abre `http://localhost:8787/`. |
| El .exe pide una .dll que falta | Copia TODA la carpeta `Release/`, no solo el .exe. |
