const syncMusicDb = require('./');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./example.sqlite');

(async () => {
    await syncMusicDb.createTable(db);

    console.time('sync');

    syncMusicDb(db, './test/Music')
        .on('ready', () => console.timeEnd('sync'))
        .on('add', track => console.log(`${track.title} added`))
        .on('remove', path => console.log(`${path} removed`))
        .on('error', err => console.error(err))
        .refresh();
})();
