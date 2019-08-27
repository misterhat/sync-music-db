# sync-music-db

<p align="center"><img src="./sync-music-db.svg" width="300"></p>

keep music metadata in sync with a [sqlite](https://sqlite.org/index.html)
database. watches a directory for changes, and updates a sqlite table with
relevant id3 (or [other metadata formats](
https://github.com/borewit/music-metadata#support-for-audio-file-types)).

## install

    $ npm install sync-music-db sqlite3

## example

```javascript
const syncMusicDb = require('sync-music-db');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./example.sqlite');

(async () => {
    await syncMusicDb.createTable(db);

    console.time('sync');

    syncMusicDb(db, './Music')
        .on('ready', () => console.timeEnd('sync'))
        .on('add', track => console.log(`${track.title} added`))
        .on('remove', path => console.log(`${path} removed`))
        .on('error', err => console.error(err))
        .refresh();
})();
```

## api
### syncMusicDb.TRACK\_ATTRS
the columns in the `tracks` table.

```javascript
[
    'path', 'mtime', 'title', 'artist', 'album', 'year', 'duration', 'track_no',
    'tags', 'is_vbr', 'bitrate', 'codec', 'container'
]
```

### async syncMusicDb.createTable(sqliteDb)
create the `tracks` table in the `sqliteDb` instance.

### syncer = syncMusicDb(sqliteDb, dir)
create an `EventEmitter` to sync the specified `dir` directory to a
[sqlite3](https://www.npmjs.com/package/sqlite3) `db` instance.

### syncer.refresh()
do an initial sync with the specified `dir` and begin watching it for
new changes.

### syncer.close()
stop syncing and watching `dir`.

### syncer.on('sync', () => {})
`sqliteDb` is up-to-date with `dir`.

### syncer.on('ready', () => {})
the initial sync has finished (from a `.refresh` call).

### syncer.on('add', track => {})
`track` has been added or updated.

### syncer.on('remove', path => {})
`path` has been removed.

### syncer.ready
a `Boolean` describing whether `syncer` is watching `dir`.

## license
LGPL-3.0+
