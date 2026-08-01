# 🔐 SKYDOG GPS — RECOVERY CARD
### What exists, where it lives, and how to get it back.
### Contains NO passwords. Safe to print, email yourself, or leave on a desk.

Last updated: 2026-08-01

---

## 1. THE ONE THING THAT CANNOT BE REPLACED

**The upload signing key.** `skydog-upload.jks`

Google identifies SkyDog GPS by this key. Every future update has to be signed
with it. There is no reset, no "forgot my key" link, no support ticket that
recovers it. Lose it and the only path forward is publishing a brand-new app
with a new package name, starting from zero users and zero reviews.

| | |
|---|---|
| Package | `com.skydog.skygps` |
| Alias | `skydog-upload` |
| Valid until | **2053-12-17** |
| SHA-1 | `94:78:50:34:AD:F4:31:7B:87:DF:C1:B4:AC:B9:E3:2B:7B:28:47:9F` |
| SHA-256 | `C7:20:23:32:49:4D:5A:8F:78:98:0F:1B:F9:3C:44:3C:43:2A:F2:BF:B1:C4:23:F6:92:D5:13:FA:7A:C8:A9:9F` |

Verified valid on 2026-08-01. Those fingerprints are public identifiers, not
secrets — if you ever need to confirm a recovered key is the right one, it must
print these exact values.

---

## 2. BACKUP STATUS — WHAT IS AND ISN'T SAFE

### ✅ DONE — source code
`github.com/skydog84/skydog-gps` (public). Every commit, forever. Also serves
the live website. Nothing to do.

### ✅ DONE — everything that only existed on the Mac
`github.com/skydog84/skydog-vault` — **PRIVATE repo, 80 files, pushed and
verified by cloning it back.**

| Folder | Contents |
|---|---|
| `handoffs/` | all 19 HANDOFF files — the entire project memory |
| `reports/` | 19 PDFs (investor overview, assessments, daily reports, flyer) |
| `build-prompts/` | the FABLE5 and other build prompt files |
| `store-assets/` | screenshots, feature graphic, Play listing copy, tester kit |
| `android-config/` | hand-edited AndroidManifest.xml, variables.gradle, build.gradle |

None of this was in git before — `.gitignore` excludes `HANDOFF*.md`, `*.pdf`
and `*PROMPT*.md` from the public repo. It existed on exactly one hard drive.

### ⚠️ NOT DONE — the signing key. **THIS IS ON YOU.**
Run **`~/Projects/skydog-backup-keys.command`** (double-click it).
It asks for a passphrase, encrypts the key, verifies the encrypted file
decrypts back byte-for-byte, and writes a copy to your Desktop.

Then:
- [ ] **Write the passphrase on paper.** Somewhere you'd keep a passport.
- [ ] **Copy the file to a USB stick**, then delete it from the Desktop.
- [ ] Keep the stick somewhere other than the laptop bag.
- [ ] *(Optional but smart)* email the encrypted file to yourself. It's AES-256
      with a 600,000-iteration key — safe to send, useless without the passphrase.

### ❌ BROKEN — iCloud Drive
**Your iCloud account is full: 1,340 bytes remaining.** Anything placed in
iCloud Drive silently fails to upload with "Quota exceeded" — the file sits in
the folder looking backed up while never leaving the machine. That is the worst
possible failure mode, so **do not use iCloud for backups** until you either
free up space or upgrade the plan (50 GB is about $0.99/month — your call, it's
your money and the GitHub vault already covers most of the need).

---

## 3. HOW TO RESTORE

### If the Mac dies and you get a new one

```bash
# 1. the code
git clone https://github.com/skydog84/skydog-gps.git ~/Projects/skydog-gps-deploy

# 2. the handoffs, reports, store assets
git clone https://github.com/skydog84/skydog-vault.git ~/Projects/skydog-vault

# 3. the signing key, from your USB stick (asks for the paper passphrase)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in SkyDog_KEYS_VAULT_<date>.tar.gz.enc | tar -xzf -

mkdir -p ~/Projects/skydog-keys
cp vault/skydog-keys/* ~/Projects/skydog-keys/
chmod 700 ~/Projects/skydog-keys
chmod 600 ~/Projects/skydog-keys/.keystore_pw
cp vault/android/keystore.properties ~/Projects/skydog-gps-deploy/android/

# 4. PROVE it's the right key — must print the SHA-1 from section 1
keytool -list -v -keystore ~/Projects/skydog-keys/skydog-upload.jks

# 5. rebuild the Android project (android/ is not in git)
npm install && npx cap add android && npx cap sync android
# then restore the hand edits from the vault's android-config/AndroidManifest.xml
```

⚠️ `keytool` needs Java 21. If it says "Unable to locate a Java Runtime", use
the full path: `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/keytool`

### If you lost the passphrase but still have the Mac
The originals are still at `~/Projects/skydog-keys/`. Re-run the backup script,
pick a new passphrase, destroy the old vault files.

### If you lost the passphrase AND the Mac
The key is gone. New package name, start over. This card exists to prevent that.

---

## 4. KEEP IT HONEST — every 3 months

- [ ] Confirm the USB stick still reads
- [ ] Confirm you can still find the paper passphrase
- [ ] `cd ~/Projects/skydog-vault && git add -A && git commit -m sync && git push`
- [ ] Re-run `skydog-backup-keys.command` after any key change

An untested backup is not a backup. Actually decrypt it once a year.

---

## 5. THE RULE THAT KEEPS THIS SAFE

**The signing key never goes into any git repo — public or private.**
Both repos have `.gitignore` rules blocking `*.jks`, `*.keystore`,
`keystore.properties`, `.keystore_pw` and `*.enc`, so it can't happen by
accident. The key travels only as the encrypted vault file.
