const SyncMusicDb = require('./');
const sqlite = require('sqlite');

(async () => {
    const db = await sqlite.open('./example.sqlite');
    const syncMusicDb = new SyncMusicDb({ db, dir: '/home/zorian/Music' });

    await syncMusicDb.createTable();

    console.time('sync');

    syncMusicDb
        .on('ready', () => console.timeEnd('sync'))
        .on('add', track => console.log(`${track.title} added`))
        .on('remove', path => console.log(`${path} removed`))
        .on('error', err => console.error(err))
        .refresh();
})();
