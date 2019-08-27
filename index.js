const audioExtensions = require('audio-extensions');
const chunk = require('chunk');
const fs = require('fs');
const mm = require('music-metadata');
const path = require('path');
const readdir = require('readdir-enhanced');
const watch = require('node-watch');
const { EventEmitter } = require('events');
const { promisify } = require('util');

// each of the columns in our database table
const TRACK_ATTRS = [
    'path', 'mtime', 'title', 'artist', 'album', 'year', 'duration', 'track_no',
    'tags', 'is_vbr', 'bitrate', 'codec', 'container'
];

const CREATE_TABLE = fs.readFileSync(`${__dirname}${path.sep}tracks.sql`)
    .toString();

// how many rows of data to buffer for database inserts and deletes
const MAX_ROWS = 25;

// TODO maybe add an option to ignore this
function isAudioFile(file) {
    const ext = path.extname(file).slice(1);
    return audioExtensions.indexOf(ext) !== -1;
}

function formatDbUpsert(tracks) {
    const placeholder = `(${TRACK_ATTRS.map(() => '?').join(',')})`;

    return `insert into tracks (${TRACK_ATTRS}) values ` +
        `${tracks.map(() => placeholder)} on conflict(path) do update set ` +
        `${TRACK_ATTRS.slice(1).map(attr => `${attr}=excluded.${attr}`)}`;
}


async function createTable(db) {
    const dbRun = promisify(db.run.bind(db));
    await dbRun(CREATE_TABLE);
}

// get each column of (TRACK_ATTRS) from the media file
async function getMetaData(path) {
    try {
        const { common, format } = await mm.parseFile(path);
        const isVbr = format.codec === 'MP3' && /^v/i.test(format.codecProfile);

        return {
            title: common.title,
            artist: common.artist,
            album: common.album,
            year: common.year,
            duration: Math.floor(format.duration),
            track_no: (common.track ? common.track.no : null),
            tags: JSON.stringify(common.genre),
            is_vbr: isVbr,
            bitrate: Math.floor(format.bitrate / 1000),
            codec: format.codec,
            container: format.container
        };
    } catch (e) {
        return {};
    }
}

class SyncMusicDb extends EventEmitter {
    constructor(db, dir) {
        super();

        this.db = db;
        this.dbAll = promisify(this.db.all.bind(this.db));
        this.dbEach = promisify(this.db.each.bind(this.db));
        this.dbRun = promisify(this.db.run.bind(this.db));

        this.dir = path.resolve(dir);

        // { path: fs.stat.mtimeMs }
        this.localMtimes = new Map();

        // is the initial sync done and are we ready to listen for new changes?
        this.ready = false;
    }

    // remove all tracks that begin with directory
    async removeDbDir(dir) {
        const query = 'delete from tracks where path like ?';
        dir = `${dir}${path.sep}%`;

        await this.dbRun(query, dir);

        this.emit('remove', dir);
    }

    // remove mutliple tracks by path
    async removeDbTracks(paths) {
        paths = Array.isArray(paths) ? paths : [ paths ];

        if (!paths.length) {
            return;
        }

        const query =
            `delete from tracks where path in (${paths.map(() => '?')})`;
        await this.dbRun(query, paths);

        paths.forEach(path => this.emit('remove', path));
    }

    // insert or update multiple tracks { path, mtime, title, ... }
    async upsertDbTracks(tracks) {
        tracks = Array.isArray(tracks) ? tracks : [ tracks ];

        if (!tracks.length) {
            return;
        }

        const queryValues = [];

        tracks.forEach(track => {
            TRACK_ATTRS.forEach(attr => queryValues.push(track[attr]));
        });

        await this.dbRun(formatDbUpsert(tracks), queryValues);

        tracks.forEach(track => this.emit('add', track));
    }

    // remove tracks that don't exist on the filesystem from our database,
    // and remove files from localMtimes that have up-to-date database entries
    async removeDeadTracks() {
        const toDelete = [];

        const query = 'select path, mtime from tracks';
        await this.dbEach(query, (err, { path, mtime }) => {
            const localMtime = this.localMtimes.get(path);

            if (!localMtime) {
                toDelete.push(path);
            } else if (localMtime <= mtime) {
                this.localMtimes.delete(path);
            }
        });

        for (const chunkedPaths of chunk(toDelete, MAX_ROWS)) {
            await this.removeDbTracks(chunkedPaths);
        }
    }

    // get the metadata from each file in localMtimes and add them to the
    // database
    async addUpdatedTracks() {
        const toAdd = [];

        for (const [ path, mtime ] of this.localMtimes) {
            toAdd.push(Object.assign({ path, mtime }, await getMetaData(path)));

            if (toAdd.length >= MAX_ROWS) {
                await this.upsertDbTracks(toAdd);
                toAdd.length = 0;
            }
        }

        await this.upsertDbTracks(toAdd);

        this.localMtimes.clear();
    }

    // grab every file recursively in the dir specified and get their last-
    // modified time
    refreshLocalMtimes() {
        this.localMtimes.clear();

        return new Promise((resolve, reject) => {
            const dirStream = readdir.stream.stat(this.dir, {
                basePath: this.dir,
                deep: true
            });

            dirStream
                .on('file', stats => {
                    if (!isAudioFile(stats.path)) {
                        return;
                    }

                    this.localMtimes.set(stats.path, Math.floor(stats.mtimeMs));
                })
                .on('end', () => resolve())
                .on('error', err => reject(err))
                .resume();
        });
    }

    // listen for file updates or removals and update the database accordingly
    refreshWatcher() {
        this.watcher = watch(this.dir, {
            delay: 1000,
            recursive: true
        }, async (evt, name) => {
            try {
                if (evt === 'update') {
                    const stats = await fs.promises.stat(name);

                    if (stats.isDirectory()) {
                        const files = await readdir.stat(name, {
                            basePath: name,
                            deep: true
                        });

                        const toAdd = [];

                        for (const file of files) {
                            if (file.isDirectory()) {
                                continue;
                            }

                            if (!isAudioFile(file.path)) {
                                continue;
                            }

                            toAdd.push(Object.assign({
                                path: file.path,
                                mtime: Math.floor(file.mtimeMs)
                            }, await getMetaData(file.path)));

                            if (toAdd.length >= MAX_ROWS) {
                                await this.upsertDbTracks(toAdd);
                                toAdd.length = 0;
                            }
                        }

                        await this.upsertDbTracks(toAdd);
                    } else {
                        if (!isAudioFile(file.path)) {
                            return;
                        }

                        await this.upsertDbTracks(Object.assign({
                            path: name,
                            mtime: Math.floor(stats.mtimeMs)
                        }, await getMetaData(name)));
                    }
                } else if (evt === 'remove') {
                    // run both because if it isn't a directory, nothing will
                    // get deleted
                    await this.removeDbTracks(name);
                    await this.removeDbDir(name);
                }
            } catch (e) {
                if (e.code !== 'ENOENT') {
                    this.emit('error', e);
                }
            }
        });
    }

    // start!
    refresh() {
        this.ready = false;
        this.close();

        this.refreshLocalMtimes()
            .then(() => this.removeDeadTracks())
            .then(() => this.addUpdatedTracks())
            .then(() => {
                this.refreshWatcher();
                this.ready = true;
                this.emit('sync');
                this.emit('ready');
            })
            .catch(err => this.emit('error', err));

        return this;
    }

    close() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }
};

module.exports = (db, dir) => new SyncMusicDb(db, dir);
module.exports.createTable = createTable;
module.exports.TRACK_ATTRS = TRACK_ATTRS;
