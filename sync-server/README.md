# The sync service

Keeps playlists, where playback stopped, muted songs and the order of Liked Songs the same on all your devices, and lets them see and steer each other. It also keeps how your library is organised: what's pinned and in which order, the library's sort, the groups, and your album edits (albums merged, renamed, given a picture or other artists, songs put on an album, artists' spellings). Which songs are liked and how often they played doesn't need it: those go through Jellyfin's own favorites and play counts.

It holds no music and has no accounts of its own: a client signs in with its Jellyfin login, and each Jellyfin user has their own documents. Merging is done by the apps; the service stores documents with a revision number and keeps the last versions of the merged ones under `versions/` (20 of the playlists, the groups and the album edits, 10 of the order, 5 of the album pictures).

An app from before a document never asks for it, and a new app finding a service from before a document keeps that part on the device until the service is updated: updating the service doesn't break older apps, and updating an app doesn't need the service updated first.

## Running it

Each Songsta release comes with a ready image, `ghcr.io/steggi-bernd/songsta-sync`, for amd64 and arm64 (a Raspberry Pi too). On the machine with your Jellyfin container, in this folder or the unpacked `songsta-sync.zip` from the [Releases page](https://github.com/steggi-bernd/Songsta/releases/latest), put your settings in a file `.env` next to `docker-compose.yml`:

```bash
JELLYFIN_NETWORK=<network Jellyfin is on>
DATA_PATH=/path/for/its/data
```

and start it:

```bash
docker compose pull && docker compose up -d
```

| Setting | Default | |
|---|---|---|
| `JELLYFIN_NETWORK` | `jellyfin` | the Docker network Jellyfin's container is on (`docker inspect jellyfin`) |
| `JELLYFIN_URL` | `http://jellyfin:8096` | how the service reaches Jellyfin on that network |
| `DATA_PATH` | `./data` | where the documents live; must be writable by user 1000 |
| `SYNC_PORT` | `8196` | the port on your network |
| `SONGSTA_SYNC_TAG` | `latest` | which release's image: `latest`, or a version such as `1.6.0` |

The apps look for it on the same host as your Jellyfin server, on port 8196. Somewhere else: enter its address in the app's settings.

Without access to ghcr.io, `docker compose up -d --build` builds the image from this folder instead.

## Updating it

In its folder:

```bash
docker compose pull && docker compose up -d
```

Its documents stay: they live in `DATA_PATH`, outside the container. The service says its version at `/health`, and once an app is linked to it, the app's settings say when it's too old for that app, and what stays on each device until it's updated. An app without a sync service asks nothing.

Set up from a `songsta-sync.zip` older than the ready image (its `docker-compose.yml` has `build: .` and no `image:`)? Replace the folder's files with the new zip's, keep your `.env` and data, then run the command above once.

To update it by itself, let cron run that once a day. Save this as `update.sh` in the service's folder:

```sh
#!/bin/sh
# Once a day: the newest released image. The container is made anew only when there is
# a newer one; the documents stay. Old Songsta images go, nothing else is touched.
cd "$(dirname "$0")" || exit 1
echo "$(date '+%Y-%m-%d %H:%M') looking for a new image"
docker compose pull --quiet || exit 1
docker compose up -d
docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/steggi-bernd/Songsta" > /dev/null
```

make it runnable with `chmod +x update.sh`, and add a line to your crontab (`crontab -e`) with the folder's full path, here for 04:23 each night:

```
23 4 * * * /home/you/songsta-sync/update.sh >> /home/you/songsta-sync/update.log 2>&1
```

The user whose crontab it is needs to be allowed to run `docker` (the `docker` group).

It speaks plain HTTP like a Jellyfin server on your home network does. Anywhere else, put it behind the same TLS proxy or tunnel as Jellyfin: when Jellyfin's address starts with `https://`, the apps look for the service under that name, at `/songsta-sync`. With a Cloudflare tunnel:

```yaml
ingress:
  - hostname: jellyfin.example.org
    path: ^/songsta-sync/
    service: http://localhost:8196
  - hostname: jellyfin.example.org
    service: http://localhost:8096
  - service: http_status:404
```

## What the apps ask of it

Everything takes the client's Jellyfin login.

| | |
|---|---|
| `GET`/`PUT /v1/docs/:name` | a document with its revision: `playlists`, `order`, `groups`, `albumedits`, `albumpictures` (merged by the apps, a write must name the revision it was built on), `queue`, `position`, `likes`, `muted` |
| `GET /v1/changes?since=&wait=&device=` | waits until something changed; answers the revisions and whether commands wait for this device |
| `GET /v1/devices` | the user's devices: what each one plays, and how long ago it said so |
| `PUT /v1/devices/:id` | what this device plays right now |
| `POST /v1/devices/:id/commands` | asks another device for something: play, pause, next, seek, take over, a new list, the volume. The service only passes these on: a new app can ask for new things without a new service |
| `GET /v1/devices/:id/commands` | this device's waiting commands, which leave the list by being read |

Commands stay for 60 seconds and live only in memory: a device that's off isn't surprised by old ones.

`GET /health` answers without a login and lists the documents this service keeps.

## Without Docker

Node 24, no dependencies:

```bash
JELLYFIN_URL=http://localhost:8096 DATA_DIR=./data node server.mjs
```
