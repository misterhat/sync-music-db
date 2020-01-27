CREATE TABLE IF NOT EXISTS $table_name (
	"id"	INTEGER,
	"path"	TEXT UNIQUE,
	"mtime"	INTEGER,
	"title"	TEXT,
	"artist"	TEXT,
	"album"	TEXT,
	"year"	INTEGER,
	"duration"	INTEGER,
	"track_no"	INTEGER,
	"disk"	INTEGER DEFAULT 1,
	"tags"	TEXT,
	"is_vbr"	INTEGER DEFAULT 0,
	"bitrate"	INTEGER,
	"codec"	TEXT,
	"container"	TEXT,
	PRIMARY KEY("id")
);

CREATE INDEX IF NOT EXISTS "artist" ON $table_name (
	"artist"	ASC
);

CREATE INDEX IF NOT EXISTS "title" ON $table_name (
	"title"
);
