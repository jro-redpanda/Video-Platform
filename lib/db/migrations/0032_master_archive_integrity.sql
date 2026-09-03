-- Existing key/time-only rows predate integrity evidence. They intentionally
-- remain valid but are unverified and cannot be restored until reconciled.
alter table videos
  add column master_sha256 text,
  add column master_size_bytes bigint,
  add column master_content_type text;

alter table videos add constraint videos_master_archive_metadata_check check (
  (master_storage_key is null and master_archived_at is null and master_sha256 is null and master_size_bytes is null and master_content_type is null)
  or (master_storage_key is not null and master_archived_at is not null and master_sha256 is null and master_size_bytes is null and master_content_type is null)
  or (
    master_storage_key is not null and master_archived_at is not null
    and master_sha256 ~ '^[a-f0-9]{64}$'
    and master_size_bytes between 1 and 9223372036854775807
    and master_content_type = btrim(master_content_type)
    and char_length(master_content_type) between 1 and 255
    and master_content_type !~ '[[:cntrl:]]'
  )
);

alter table master_storage_operations
  add column restore_sha256 text,
  add column restore_size_bytes bigint,
  add column restore_content_type text;

-- 0031 only allowed restore keys. New restore work must snapshot the complete
-- verified archive identity; old rows remain readable for forensic history.
alter table master_storage_operations drop constraint master_storage_operations_restore_key_check;
alter table master_storage_operations add constraint master_storage_operations_restore_snapshot_check check (
  (operation = 'archive'
    and restore_storage_key is null and restore_sha256 is null and restore_size_bytes is null and restore_content_type is null)
  or (operation = 'restore'
    and restore_storage_key is not null
    and restore_sha256 ~ '^[a-f0-9]{64}$'
    and restore_size_bytes between 1 and 9223372036854775807
    and restore_content_type = btrim(restore_content_type)
    and char_length(restore_content_type) between 1 and 255
    and restore_content_type !~ '[[:cntrl:]]')
) not valid;