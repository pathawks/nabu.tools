# nabu

Every piece of dumping hardware I own came with its own software. Some of it is
Windows-only. Some of it requires Python 2. One of them needed me to compile a
C program with a Makefile that didn't work on my machine without edits. Another
had a GUI that looked like it was designed in 2004, because it was.

I just wanted to back up my games.

nabu is a browser-based cartridge dumper. Plug in your hardware, open the page,
and dump your cartridges. No installs, no drivers, no build toolchains. It runs
entirely in the browser using Web Serial and WebHID, so it works on any desktop
OS with a modern browser.

The name comes from the
[Mesopotamian god of writing and wisdom](https://en.wikipedia.org/wiki/Nabu) --
keeper of knowledge. Seemed fitting for a preservation tool.

## Supported Hardware

| Device | Connection | Systems |
| --- | --- | --- |
| [GBxCart RW](https://www.gbxcart.com/) v1.4 Pro | Web Serial | Game Boy, Game Boy Color, Game Boy Advance |
| PowerSaves for Amiibo | WebHID | Amiibo (NTAG215) |

This is still early. More hardware and more systems are in the works.

## Linux setup

Linux blocks browser access to USB devices by default — they won't appear in
Chrome's device picker until a udev rule grants the desktop user access. Each
device's info button on the connect screen shows the rule it needs, or you can
drop in [`linux/99-nabu.rules`](linux/99-nabu.rules) which covers every
supported device:

```sh
sudo cp linux/99-nabu.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then unplug and replug the device. macOS and Windows don't need this.

## What It Does

- **Dumps ROMs** from Game Boy, Game Boy Color, and Game Boy Advance cartridges
- **Backs up save data** (SRAM, Flash, EEPROM)
- **Reads Amiibo** tags (and generic NTAG215 tags, best-effort)
- **Verifies dumps** against the No-Intro database using CRC32, SHA-1, and SHA-256
- **Auto-detects** the inserted cartridge -- title, mapper, ROM size, save type

The interface is a step-by-step wizard: connect your device, configure the dump,
watch it run, save the files. There's an event log in the sidebar if something
goes sideways.

## Development

```sh
npm install
npm run dev
```

This will start a local Vite dev server. You'll need a Chromium-based browser
for Web Serial and WebHID support (sorry, Firefox).

```sh
npm run build
npm run lint
```

## License

[GPL-3.0](LICENSE)

See [THIRD-PARTY-LICENSES](THIRD-PARTY-LICENSES) for attribution of code
derived from [FlashGBX](https://github.com/lesserkuma/FlashGBX),
[amiigo](https://github.com/malc0mn/amiigo), and
[AmiiboAPI](https://github.com/N3evin/AmiiboAPI).
