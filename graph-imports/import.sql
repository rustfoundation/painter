BEGIN;
    -- Disable triggers on each table.

    ALTER TABLE "categories" DISABLE TRIGGER ALL;

    ALTER TABLE "crates" DISABLE TRIGGER ALL;

    ALTER TABLE "keywords" DISABLE TRIGGER ALL;

    ALTER TABLE "metadata" DISABLE TRIGGER ALL;

    ALTER TABLE "reserved_crate_names" DISABLE TRIGGER ALL;

    ALTER TABLE "teams" DISABLE TRIGGER ALL;

    ALTER TABLE "users" DISABLE TRIGGER ALL;

    ALTER TABLE "badges" DISABLE TRIGGER ALL;

    ALTER TABLE "crates_categories" DISABLE TRIGGER ALL;

    ALTER TABLE "crates_keywords" DISABLE TRIGGER ALL;

    ALTER TABLE "crate_owners" DISABLE TRIGGER ALL;

    ALTER TABLE "versions" DISABLE TRIGGER ALL;

    ALTER TABLE "dependencies" DISABLE TRIGGER ALL;

    ALTER TABLE "version_downloads" DISABLE TRIGGER ALL;


    -- Set defaults for non-nullable columns not included in the dump.














    ALTER TABLE "users" ALTER COLUMN "gh_access_token" SET DEFAULT '';

















    -- Truncate all tables.

    TRUNCATE "categories" RESTART IDENTITY CASCADE;

    TRUNCATE "crates" RESTART IDENTITY CASCADE;

    TRUNCATE "keywords" RESTART IDENTITY CASCADE;

    TRUNCATE "metadata" RESTART IDENTITY CASCADE;

    TRUNCATE "reserved_crate_names" RESTART IDENTITY CASCADE;

    TRUNCATE "teams" RESTART IDENTITY CASCADE;

    TRUNCATE "users" RESTART IDENTITY CASCADE;

    TRUNCATE "badges" RESTART IDENTITY CASCADE;

    TRUNCATE "crates_categories" RESTART IDENTITY CASCADE;

    TRUNCATE "crates_keywords" RESTART IDENTITY CASCADE;

    TRUNCATE "crate_owners" RESTART IDENTITY CASCADE;

    TRUNCATE "versions" RESTART IDENTITY CASCADE;

    TRUNCATE "dependencies" RESTART IDENTITY CASCADE;

    TRUNCATE "version_downloads" RESTART IDENTITY CASCADE;


    -- Enable this trigger so that `crates.textsearchable_index_col` can be excluded from the export
    ALTER TABLE "crates" ENABLE TRIGGER "trigger_crates_tsvector_update";

    -- Import the CSV data.

    \copy "categories" ("category", "crates_cnt", "created_at", "description", "id", "path", "slug") FROM 'data/categories.csv' WITH CSV HEADER

    \copy "crates" ("created_at", "description", "documentation", "downloads", "homepage", "id", "max_upload_size", "name", "readme", "repository", "updated_at") FROM 'data/crates.csv' WITH CSV HEADER

    \copy "keywords" ("crates_cnt", "created_at", "id", "keyword") FROM 'data/keywords.csv' WITH CSV HEADER

    \copy "metadata" ("total_downloads") FROM 'data/metadata.csv' WITH CSV HEADER

    \copy "reserved_crate_names" ("name") FROM 'data/reserved_crate_names.csv' WITH CSV HEADER

    \copy "teams" ("avatar", "github_id", "id", "login", "name", "org_id") FROM 'data/teams.csv' WITH CSV HEADER

    \copy "users" ("gh_avatar", "gh_id", "gh_login", "id", "name") FROM 'data/users.csv' WITH CSV HEADER

    \copy "badges" ("attributes", "badge_type", "crate_id") FROM 'data/badges.csv' WITH CSV HEADER

    \copy "crates_categories" ("category_id", "crate_id") FROM 'data/crates_categories.csv' WITH CSV HEADER

    \copy "crates_keywords" ("crate_id", "keyword_id") FROM 'data/crates_keywords.csv' WITH CSV HEADER

    \copy "crate_owners" ("crate_id", "created_at", "created_by", "owner_id", "owner_kind") FROM 'data/crate_owners.csv' WITH CSV HEADER

    \copy "versions" ("checksum", "crate_id", "crate_size", "created_at", "downloads", "features", "id", "license", "links", "num", "published_by", "updated_at", "yanked") FROM 'data/versions.csv' WITH CSV HEADER

    \copy "dependencies" ("crate_id", "default_features", "explicit_name", "features", "id", "kind", "optional", "req", "target", "version_id") FROM 'data/dependencies.csv' WITH CSV HEADER

    \copy "version_downloads" ("date", "downloads", "version_id") FROM 'data/version_downloads.csv' WITH CSV HEADER


    -- Drop the defaults again.














    ALTER TABLE "users" ALTER COLUMN "gh_access_token" DROP DEFAULT;

















    -- Reenable triggers on each table.

    ALTER TABLE "categories" ENABLE TRIGGER ALL;

    ALTER TABLE "crates" ENABLE TRIGGER ALL;

    ALTER TABLE "keywords" ENABLE TRIGGER ALL;

    ALTER TABLE "metadata" ENABLE TRIGGER ALL;

    ALTER TABLE "reserved_crate_names" ENABLE TRIGGER ALL;

    ALTER TABLE "teams" ENABLE TRIGGER ALL;

    ALTER TABLE "users" ENABLE TRIGGER ALL;

    ALTER TABLE "badges" ENABLE TRIGGER ALL;

    ALTER TABLE "crates_categories" ENABLE TRIGGER ALL;

    ALTER TABLE "crates_keywords" ENABLE TRIGGER ALL;

    ALTER TABLE "crate_owners" ENABLE TRIGGER ALL;

    ALTER TABLE "versions" ENABLE TRIGGER ALL;

    ALTER TABLE "dependencies" ENABLE TRIGGER ALL;

    ALTER TABLE "version_downloads" ENABLE TRIGGER ALL;

COMMIT;