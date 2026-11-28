# Reach Worker for macOS and Linux

Portable preview · Ray Zhang (Ray)

This build connects a Mac or Linux computer to Reach for heartbeat, command execution, and file operations. `ryreach run` runs in the foreground as your account. This preview ships the Worker only. Desktop control, Morrow Agent, bundled OpenSSH and startup at login are outside this preview.

Choose `macos-arm64` for Apple Silicon or `macos-x64` for an Intel Mac. On Linux, check `uname -m` and choose `linux-x64` for `x86_64` or `linux-arm64` for `aarch64`. The Linux build requires glibc. The macOS preview is distributed without Developer ID signing or notarization.

1. Compare the archive's SHA-256 with the value on the download page or beside the archive. Use `shasum -a 256 <archive>` on macOS or `sha256sum <archive>` on Linux.
2. Extract the archive to a directory you own and open a terminal in that directory.
3. In the Reach web console, generate a pairing code under **Devices**. Use the URL shown by your console, including its `/reach` path if present.

   ```sh
   ./ryreach config set server-url 'https://your-reach-host.example/reach'
   ./ryreach pair YOUR_PAIRING_CODE
   ./ryreach run
   ```

4. Check the device appears online in Reach. Keep the terminal open to stay online. Wait for all operations to finish before pressing Ctrl+C to stop the Worker or replacing the executable.

Reach keeps this device's pairing and operation receipts in `~/.local/state/ry-reach`. Keep that directory when upgrading the Worker.
