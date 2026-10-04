# StreetSweep for iPad

The native iPad app. The plan and decisions are in `../docs/IOS-PLAN.md`.

## Open and run

The Xcode project is generated from `project.yml`, so it isn't in git. After a pull,
or after adding or removing files:

```bash
cd v2/ios && xcodegen generate && open StreetSweep.xcodeproj
```

Pick an iPad simulator (or your iPad) and press Run.

## On your own iPad

1. Xcode → Settings → Accounts: add your Apple ID. A free one is fine.
2. Select the StreetSweep target → Signing & Capabilities → pick your Personal Team.
   If Xcode says the bundle id is taken, change `net.streetsweep.ipad` to something of
   your own.
3. On the iPad: Settings → Privacy & Security → Developer Mode → on (it restarts).
4. Plug the iPad in (or pair it over Wi-Fi in Window → Devices and Simulators), pick
   it as the run destination, and press Run. The first time, trust your developer
   profile on the iPad: Settings → General → VPN & Device Management.

With a free Apple ID the install stops opening after 7 days; press Run again to renew.

## Server address

The app signs in to streetsweep.net. "Use a different server" on the sign-in screen
points it elsewhere: while developing, the Mac's address on your network and the
stack's port, e.g. `192.168.1.20:8430` (the simulator can use `localhost:8430`). A bare
address is taken as `http://`, a domain as `https://`. The first connection to a local
address asks for Local Network permission: allow it.

Debug builds can sign in by themselves from the launch environment (`SS_DEV_SERVER`,
`SS_DEV_EMAIL`, `SS_DEV_PASSWORD`; pass them as `SIMCTL_CHILD_…` to `simctl launch`).

## Command line

```bash
xcodebuild -project StreetSweep.xcodeproj -scheme StreetSweep \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' -derivedDataPath build build
```
