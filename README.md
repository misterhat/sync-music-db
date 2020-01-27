# sync-music-db

<p align="center"><img src="./sync-music-db.svg" width="300"></p>

keep music metadata in sync with a [sqlite](https://sqlite.org/index.html)
database. watches a directory for changes, and updates a sqlite table with
relevant id3 (or [other metadata formats](
https://github.com/borewit/music-metadata#support-for-audio-file-types)).

this module is intended to be used with media players, but is appropriate for
anything that relies on a music library.

## install

    $ npm install sync-music-db sqlite

[sqlite](https://www.npmjs.com/package/sqlite) is a
[peerDependency](https://docs.npmjs.com/files/package.json#peerdependencies).
this module doesn't explicitly `require` it, but it takes a sqlite `db`
instance in its constructor.

## example

```javascript
const SyncMusicDb = require('./');
const sqlite = require('sqlite');

(async () => {
    const db = await sqlite.open('./example.sqlite');
    const syncMusicDb = new SyncMusicDb({ db, dir: './test/_music' });

    await syncMusicDb.createTable();

    console.time('sync');

    syncMusicDb
        .on('ready', () => console.timeEnd('sync'))
        .on('add', track => console.log(`${track.title} added`))
        .on('remove', path => console.log(`${path} removed`))
        .on('error', err => console.error(err))
        .refresh();
})();
```

## api
### SyncMusicDb.TRACK\_ATTRS
the columns in the `tracks` table.

```javascript
[
    'path', 'mtime', 'title', 'artist', 'album', 'year', 'duration', 'track_no',
    'tags', 'is_vbr', 'bitrate', 'codec', 'container'
]
```

### syncMusicDb = new SyncMusicDb({ db, dir, tableName = 'tracks', delay = 1000, ignoreExt = true })
create an `EventEmitter` to sync the specified `dir` directory to a
[sqlite](https://www.npmjs.com/package/sqlite) `db` instance.

`tableName` specifies which table has `SyncMusicDb.TRACK_ATTRS`.

`delay` specifies how long to wait for file changes (in ms) before reading them.

`ignoreExt` specifies whether to ignore non-media extensions.

### async syncMusicDb.createTable()
create the `tracks` table in the `sqliteDb` instance.

### syncMusicDb.refresh()
do an initial sync with the specified `dir` and begin watching it for
new changes.

### async syncMusicDb.close()
stop syncing and watching `dir`.

### syncMusicDb.on('synced', isSynced => {})
is `sqliteDb` up-to-date with `dir`?

### syncMusicDb.on('ready', () => {})
the initial sync has finished (from a `.refresh` call).

### syncMusicDb.on('add', track => {})
`track` has been added or updated.

### syncMusicDb.on('remove', path => {})
`path` has been removed.

### syncMusicDb.isReady
is `syncMusicDb` listening to live `dir` changes (after initial scan)?

### syncMusicDb.isSynced
is all the metadata from `dir` stored in `db`?

## license
LGPL-3.0+
