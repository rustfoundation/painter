BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;


    \copy "categories" ("category", "crates_cnt", "created_at", "description", "id", "path", "slug") TO 'data/categories.csv' WITH CSV HEADER



    \copy "crates" ("created_at", "description", "documentation", "downloads", "homepage", "id", "max_upload_size", "name", "readme", "repository", "updated_at") TO 'data/crates.csv' WITH CSV HEADER



    \copy "keywords" ("crates_cnt", "created_at", "id", "keyword") TO 'data/keywords.csv' WITH CSV HEADER



    \copy "metadata" ("total_downloads") TO 'data/metadata.csv' WITH CSV HEADER



    \copy "reserved_crate_names" ("name") TO 'data/reserved_crate_names.csv' WITH CSV HEADER



    \copy "teams" ("avatar", "github_id", "id", "login", "name", "org_id") TO 'data/teams.csv' WITH CSV HEADER



    \copy (SELECT "gh_avatar", "gh_id", "gh_login", "id", "name" FROM "users" WHERE id in (     SELECT owner_id AS user_id FROM crate_owners WHERE NOT deleted AND owner_kind = 0     UNION     SELECT published_by as user_id FROM versions )) TO 'data/users.csv' WITH CSV HEADER



    \copy "badges" ("attributes", "badge_type", "crate_id") TO 'data/badges.csv' WITH CSV HEADER



    \copy "crates_categories" ("category_id", "crate_id") TO 'data/crates_categories.csv' WITH CSV HEADER



    \copy "crates_keywords" ("crate_id", "keyword_id") TO 'data/crates_keywords.csv' WITH CSV HEADER



    \copy (SELECT "crate_id", "created_at", "created_by", "owner_id", "owner_kind" FROM "crate_owners" WHERE NOT deleted) TO 'data/crate_owners.csv' WITH CSV HEADER



    \copy "versions" ("checksum", "crate_id", "crate_size", "created_at", "downloads", "features", "id", "license", "links", "num", "published_by", "updated_at", "yanked") TO 'data/versions.csv' WITH CSV HEADER



    \copy "dependencies" ("crate_id", "default_features", "explicit_name", "features", "id", "kind", "optional", "req", "target", "version_id") TO 'data/dependencies.csv' WITH CSV HEADER



    \copy (SELECT "date", "downloads", "version_id" FROM "version_downloads" WHERE date > current_date - interval '90 day') TO 'data/version_downloads.csv' WITH CSV HEADER


COMMIT;