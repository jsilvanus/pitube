# systemd user unit

`pitube.service` runs pitube as a systemd user service.

Expected layout (relative to the service user's home, `%h`):

- app checkout (built, with `dist/`): `~/apps/pitube`
- environment file: `~/apps/pitube.env` (all settings and secrets live here, never in git)
- Node.js: `~/.local/bin/node`

The `After=pigateway.service` line only orders startup; pitube works without pigateway running.

Install:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/pitube.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pitube
loginctl enable-linger "$USER"   # once, so it runs without a login session
```

Status and logs: `systemctl --user status pitube`, `journalctl --user -u pitube -f`.
