create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  display_name text not null default 'Membre',
  bio text not null default '',
  avatar_url text,
  points integer not null default 2 check (points >= 0),
  is_admin boolean not null default false,
  is_banned boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists email text;
update public.profiles p
set email = coalesce(u.email, '')
from auth.users u
where p.id = u.id and p.email is null;
alter table public.profiles alter column email set not null;

create or replace function public.validate_profile_avatar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.avatar_url is not null and (
    new.avatar_url not like (new.id::text || '/%')
    or not exists (
      select 1 from storage.objects
      where bucket_id = 'marketplace-media'
        and name = new.avatar_url
        and owner_id = new.id::text
    )
  ) then
    raise exception 'Upload a profile photo to your account before saving it.';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_profile_avatar_before_update on public.profiles;
create trigger validate_profile_avatar_before_update
before update of avatar_url on public.profiles
for each row execute function public.validate_profile_avatar();

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  caption text not null default '',
  media_url text not null,
  media_type text not null check (media_type in ('image', 'video')),
  product_name text,
  price numeric(12, 3) check (price is null or price >= 0),
  category text not null default 'Autre',
  created_at timestamptz not null default now()
);
alter table public.posts add column if not exists media_urls text[] not null default array[]::text[];

create table if not exists public.post_likes (
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create table if not exists public.post_saves (
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid references public.posts(id) on delete set null,
  body text not null check (length(body) between 1 and 2000),
  attachment_url text,
  attachment_type text check (attachment_type in ('image', 'audio')),
  created_at timestamptz not null default now(),
  check (sender_id <> recipient_id)
);
alter table public.messages add column if not exists attachment_url text;
alter table public.messages add column if not exists attachment_type text;
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages add constraint messages_content_check check (
  (length(trim(body)) between 1 and 2000)
  or (length(trim(body)) = 0 and attachment_url is not null)
);
alter table public.messages drop constraint if exists messages_attachment_type_check;
alter table public.messages add constraint messages_attachment_type_check
  check (attachment_type is null or attachment_type in ('image', 'audio'));

create table if not exists public.point_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null check (amount between 1 and 100000),
  price_dinar numeric(12, 3) not null default 0 check (price_dinar >= 0),
  provider text not null check (provider in ('D17', 'Ooredoo', 'Flouci')),
  destination text not null,
  receipt_url text not null,
  note text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_reason text not null default '',
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.point_requests add column if not exists price_dinar numeric(12, 3) not null default 0;

create table if not exists public.app_settings (
  id integer primary key check (id = 1),
  schema_version integer not null default 3,
  d17 text not null default '90272020',
  ooredoo text not null default '90576380',
  flouci text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.app_settings add column if not exists schema_version integer not null default 3;
alter table public.app_settings alter column d17 set default '90272020';
alter table public.app_settings alter column ooredoo set default '90576380';
insert into public.app_settings (id, d17, ooredoo)
values (1, '90272020', '90576380')
on conflict (id) do nothing;
update public.app_settings set schema_version = 3 where id = 1 and schema_version < 3;
update public.app_settings set d17 = '90272020' where id = 1 and trim(d17) = '';
update public.app_settings set ooredoo = '90576380' where id = 1 and trim(ooredoo) = '';

create or replace view public.public_profiles
as
select id, display_name, bio, avatar_url, created_at
from public.profiles
where is_banned = false;

create or replace function public.is_marketplace_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and is_admin and not is_banned
  );
$$;

create or replace function public.is_marketplace_banned()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select is_banned from public.profiles where id = (select auth.uid())
  ), false);
$$;

create or replace function public.admin_update_payment_settings(
  p_d17 text,
  p_ooredoo text,
  p_flouci text
)
returns public.app_settings
language plpgsql
security definer
set search_path = ''
as $$
declare v_settings public.app_settings;
begin
  if not public.is_marketplace_admin() then raise exception 'Admin access required.'; end if;
  update public.app_settings
  set d17 = coalesce(p_d17, ''),
      ooredoo = coalesce(p_ooredoo, ''),
      flouci = coalesce(p_flouci, ''),
      updated_at = now()
  where id = 1
  returning * into v_settings;
  return v_settings;
end;
$$;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id, coalesce(new.email, ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), 'Membre')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.create_profile_for_new_user();

insert into public.profiles (id, email, display_name)
select
  u.id,
  coalesce(u.email, ''),
  coalesce(nullif(u.raw_user_meta_data ->> 'display_name', ''), 'Membre')
from auth.users u
on conflict (id) do update set email = excluded.email;

create or replace function public.create_post(
  p_caption text,
  p_media_url text,
  p_media_type text,
  p_product_name text default null,
  p_price numeric default null,
  p_category text default 'Autre'
)
returns public.posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.posts;
  v_cost integer;
begin
  if auth.uid() is null or public.is_marketplace_banned() then
    raise exception 'Your account cannot publish posts.';
  end if;
  if p_media_type not in ('image', 'video') then
    raise exception 'Unsupported media type.';
  end if;
  if p_media_url not like (auth.uid()::text || '/%')
    or not exists (
      select 1 from storage.objects
      where bucket_id = 'marketplace-media' and name = p_media_url
        and owner_id = auth.uid()::text
    ) then
    raise exception 'Upload the media to your account before publishing.';
  end if;
  if length(coalesce(p_caption, '')) > 2000 then
    raise exception 'Caption is too long.';
  end if;
  v_cost := case when p_media_type = 'video' then 2 else 1 end;
  update public.profiles
  set points = points - v_cost
  where id = auth.uid() and points >= v_cost;
  if not found then
    raise exception 'Not enough points to publish this post.';
  end if;
  insert into public.posts (user_id, caption, media_url, media_type, media_urls, product_name, price, category)
  values (
    auth.uid(), coalesce(p_caption, ''), p_media_url, p_media_type, array[p_media_url],
    nullif(p_product_name, ''), p_price, coalesce(nullif(p_category, ''), 'Autre')
  )
  returning * into v_post;
  return v_post;
end;
$$;

create or replace function public.create_photo_post(
  p_caption text,
  p_media_urls text[],
  p_product_name text default null,
  p_price numeric default null,
  p_category text default 'Autre'
)
returns public.posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.posts;
  v_count integer;
  v_valid_count integer;
begin
  if auth.uid() is null or public.is_marketplace_banned() then
    raise exception 'Your account cannot publish posts.';
  end if;
  v_count := coalesce(array_length(p_media_urls, 1), 0);
  if v_count < 1 or v_count > 6 then
    raise exception 'Choisis entre 1 et 6 photos.';
  end if;
  if length(coalesce(p_caption, '')) > 2000 then
    raise exception 'Caption is too long.';
  end if;
  select count(*) into v_valid_count
  from unnest(p_media_urls) as uploaded(path)
  join storage.objects stored_media
    on stored_media.bucket_id = 'marketplace-media'
    and stored_media.name = uploaded.path
    and stored_media.owner_id = auth.uid()::text
  where uploaded.path like (auth.uid()::text || '/%');
  if v_valid_count <> v_count then
    raise exception 'Upload all photos to your account before publishing.';
  end if;
  update public.profiles
  set points = points - v_count
  where id = auth.uid() and points >= v_count;
  if not found then
    raise exception 'Il te faut % points pour publier ces photos.', v_count;
  end if;
  insert into public.posts (user_id, caption, media_url, media_type, media_urls, product_name, price, category)
  values (
    auth.uid(), coalesce(p_caption, ''), p_media_urls[1], 'image', p_media_urls,
    nullif(p_product_name, ''), p_price, coalesce(nullif(p_category, ''), 'Autre')
  )
  returning * into v_post;
  return v_post;
end;
$$;

create or replace function public.update_post(
  p_post_id uuid,
  p_caption text,
  p_product_name text,
  p_price numeric,
  p_category text
)
returns public.posts
language plpgsql
security definer
set search_path = ''
as $$
declare v_post public.posts;
begin
  if auth.uid() is null or public.is_marketplace_banned() then
    raise exception 'Your account cannot edit posts.';
  end if;
  update public.posts
  set caption = coalesce(p_caption, ''),
      product_name = nullif(trim(coalesce(p_product_name, '')), ''),
      price = p_price,
      category = coalesce(nullif(trim(p_category), ''), 'Autre')
  where id = p_post_id
    and (user_id = auth.uid() or public.is_marketplace_admin())
  returning * into v_post;
  if not found then raise exception 'Publication introuvable ou accès refusé.'; end if;
  return v_post;
end;
$$;

create or replace function public.toggle_like(p_post_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.is_marketplace_banned() then
    raise exception 'Your account cannot interact with posts.';
  end if;
  delete from public.post_likes where user_id = auth.uid() and post_id = p_post_id;
  if found then return false; end if;
  insert into public.post_likes (user_id, post_id) values (auth.uid(), p_post_id);
  return true;
end;
$$;

create or replace function public.toggle_save(p_post_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.is_marketplace_banned() then
    raise exception 'Your account cannot save posts.';
  end if;
  delete from public.post_saves where user_id = auth.uid() and post_id = p_post_id;
  if found then return false; end if;
  insert into public.post_saves (user_id, post_id) values (auth.uid(), p_post_id);
  return true;
end;
$$;

create or replace function public.create_comment(p_post_id uuid, p_body text)
returns public.comments
language plpgsql
security definer
set search_path = ''
as $$
declare v_comment public.comments;
begin
  if auth.uid() is null or public.is_marketplace_banned() then
    raise exception 'Your account cannot comment.';
  end if;
  insert into public.comments (post_id, user_id, body)
  values (p_post_id, auth.uid(), trim(p_body))
  returning * into v_comment;
  return v_comment;
end;
$$;

drop function if exists public.create_point_request(integer, text, text, text, text);
create or replace function public.create_point_request(
  p_amount integer,
  p_price_dinar numeric,
  p_provider text,
  p_destination text,
  p_receipt_url text,
  p_note text default ''
)
returns public.point_requests
language plpgsql
security definer
set search_path = ''
as $$
declare v_request public.point_requests;
begin
  if auth.uid() is null or public.is_marketplace_banned() then
    raise exception 'Your account cannot request points.';
  end if;
  if length(trim(coalesce(p_destination, ''))) = 0 then
    raise exception 'Ajoute le numéro ou identifiant utilisé pour payer.';
  end if;
  if not ((p_amount = 4 and p_price_dinar = 4) or (p_amount = 10 and p_price_dinar = 10)) then
    raise exception 'Choisis une offre de recharge disponible.';
  end if;
  if p_receipt_url not like (auth.uid()::text || '/%')
    or not exists (
      select 1 from storage.objects
      where bucket_id = 'marketplace-receipts' and name = p_receipt_url
        and owner_id = auth.uid()::text
    ) then
    raise exception 'Upload a receipt to your account before requesting points.';
  end if;
  insert into public.point_requests (user_id, amount, price_dinar, provider, destination, receipt_url, note)
  values (auth.uid(), p_amount, p_price_dinar, p_provider, trim(p_destination), p_receipt_url, coalesce(p_note, ''))
  returning * into v_request;
  return v_request;
end;
$$;

create or replace function public.admin_review_point_request(
  p_request_id uuid,
  p_approve boolean,
  p_reason text default ''
)
returns public.point_requests
language plpgsql
security definer
set search_path = ''
as $$
declare v_request public.point_requests;
begin
  if not public.is_marketplace_admin() then raise exception 'Admin access required.'; end if;
  select * into v_request
  from public.point_requests
  where id = p_request_id and status = 'pending'
  for update;
  if not found then raise exception 'Request not found or already reviewed.'; end if;
  update public.point_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      admin_reason = trim(coalesce(p_reason, '')),
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = p_request_id
  returning * into v_request;
  if p_approve then
    update public.profiles set points = points + v_request.amount where id = v_request.user_id;
  elsif length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to reject a request.';
  end if;
  return v_request;
end;
$$;

create or replace function public.admin_update_user(
  p_user_id uuid,
  p_points_delta integer default 0,
  p_is_banned boolean default null
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare v_profile public.profiles;
begin
  if not public.is_marketplace_admin() then raise exception 'Admin access required.'; end if;
  if p_user_id = auth.uid() and p_is_banned is true then
    raise exception 'You cannot suspend your own admin account.';
  end if;
  update public.profiles
  set points = greatest(0, points + coalesce(p_points_delta, 0)),
      is_banned = coalesce(p_is_banned, is_banned)
  where id = p_user_id
  returning * into v_profile;
  if not found then raise exception 'User not found.'; end if;
  return v_profile;
end;
$$;

drop function if exists public.send_private_message(uuid, text, uuid);
drop function if exists public.send_private_message(uuid, text, uuid, text, text);
create function public.send_private_message(
  p_recipient_id uuid,
  p_body text,
  p_post_id uuid default null,
  p_attachment_url text default null,
  p_attachment_type text default null
)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare v_message public.messages;
begin
  if auth.uid() is null or public.is_marketplace_banned() then
    raise exception 'Your account cannot send messages.';
  end if;
  if p_attachment_type is not null and p_attachment_type not in ('image', 'audio') then
    raise exception 'Unsupported message attachment.';
  end if;
  if (p_attachment_url is null) <> (p_attachment_type is null) then
    raise exception 'Message attachment metadata is incomplete.';
  end if;
  if p_attachment_url is not null and (
    p_attachment_type is null
    or p_attachment_url not like (auth.uid()::text || '/%')
    or not exists (
      select 1 from storage.objects
      where bucket_id = 'marketplace-message-media'
        and name = p_attachment_url
        and owner_id = auth.uid()::text
    )
  ) then
    raise exception 'Upload the attachment to your account before sending it.';
  end if;
  if length(trim(coalesce(p_body, ''))) = 0 and p_attachment_url is null then
    raise exception 'Écris un message ou ajoute un fichier.';
  end if;
  insert into public.messages (sender_id, recipient_id, body, post_id, attachment_url, attachment_type)
  values (auth.uid(), p_recipient_id, trim(coalesce(p_body, '')), p_post_id, p_attachment_url, p_attachment_type)
  returning * into v_message;
  return v_message;
end;
$$;

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.post_likes enable row level security;
alter table public.post_saves enable row level security;
alter table public.comments enable row level security;
alter table public.messages enable row level security;
alter table public.point_requests enable row level security;
alter table public.app_settings enable row level security;

drop policy if exists "Profiles visible to owner and admins" on public.profiles;
create policy "Profiles visible to owner and admins" on public.profiles
for select to authenticated
using (id = (select auth.uid()) or public.is_marketplace_admin());
drop policy if exists "Owners update their profile" on public.profiles;
create policy "Owners update their profile" on public.profiles
for update to authenticated
using (id = (select auth.uid()) and not public.is_marketplace_banned())
with check (id = (select auth.uid()) and not is_admin and not is_banned);
drop policy if exists "Admins update profiles" on public.profiles;
create policy "Admins update profiles" on public.profiles
for update to authenticated
using (public.is_marketplace_admin())
with check (public.is_marketplace_admin());

revoke update on public.profiles from authenticated;
grant update (display_name, bio, avatar_url) on public.profiles to authenticated;
revoke update on public.posts, public.comments, public.point_requests, public.messages, public.app_settings from authenticated;

drop policy if exists "Posts visible to visitors" on public.posts;
create policy "Posts visible to visitors" on public.posts for select to anon, authenticated using (true);
drop policy if exists "Users create their own posts" on public.posts;
revoke insert on public.posts from authenticated;
drop policy if exists "Owners and admins delete posts" on public.posts;
create policy "Owners and admins delete posts" on public.posts for delete to authenticated
using (user_id = (select auth.uid()) or public.is_marketplace_admin());

drop policy if exists "Like rows visible to signed-in users" on public.post_likes;
create policy "Like rows visible to signed-in users" on public.post_likes
for select to authenticated using (true);
drop policy if exists "Users manage their own likes" on public.post_likes;
create policy "Users manage their own likes" on public.post_likes
for all to authenticated
using (user_id = (select auth.uid()) and not public.is_marketplace_banned())
with check (user_id = (select auth.uid()) and not public.is_marketplace_banned());
drop policy if exists "Save rows visible to owner" on public.post_saves;
create policy "Save rows visible to owner" on public.post_saves
for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "Users manage their own saves" on public.post_saves;
create policy "Users manage their own saves" on public.post_saves
for all to authenticated
using (user_id = (select auth.uid()) and not public.is_marketplace_banned())
with check (user_id = (select auth.uid()) and not public.is_marketplace_banned());

drop policy if exists "Comments visible to visitors" on public.comments;
create policy "Comments visible to visitors" on public.comments
for select to anon, authenticated using (true);
drop policy if exists "Users create their own comments" on public.comments;
create policy "Users create their own comments" on public.comments
for insert to authenticated
with check (user_id = (select auth.uid()) and not public.is_marketplace_banned());
drop policy if exists "Owners and admins delete comments" on public.comments;
create policy "Owners and admins delete comments" on public.comments
for delete to authenticated
using (user_id = (select auth.uid()) or public.is_marketplace_admin());

drop policy if exists "Private messages for participants" on public.messages;
create policy "Private messages for participants" on public.messages
for select to authenticated
using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()) or public.is_marketplace_admin());
drop policy if exists "Users send their own messages" on public.messages;
revoke insert on public.messages from authenticated;

drop policy if exists "Point requests visible to owner and admins" on public.point_requests;
create policy "Point requests visible to owner and admins" on public.point_requests
for select to authenticated
using (user_id = (select auth.uid()) or public.is_marketplace_admin());
drop policy if exists "Users create their own point requests" on public.point_requests;

drop policy if exists "Payment settings are public" on public.app_settings;
create policy "Payment settings are public" on public.app_settings
for select to anon, authenticated using (true);

revoke all on public.profiles, public.posts, public.post_likes, public.post_saves,
  public.comments, public.messages, public.point_requests, public.app_settings
from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.posts, public.comments to anon, authenticated;
grant select on public.public_profiles to anon, authenticated;
grant select on public.profiles, public.post_likes, public.post_saves, public.messages, public.point_requests to authenticated;
grant select on public.app_settings to anon, authenticated;
grant update (display_name, bio, avatar_url) on public.profiles to authenticated;
grant insert, delete on public.post_likes, public.post_saves to authenticated;
grant insert on public.comments to authenticated;
grant delete on public.posts, public.comments to authenticated;
revoke execute on function public.is_marketplace_admin() from public, anon;
revoke execute on function public.is_marketplace_banned() from public, anon;
grant execute on function public.is_marketplace_admin() to authenticated;
grant execute on function public.is_marketplace_banned() to authenticated;
revoke execute on function public.create_post(text, text, text, text, numeric, text) from public, anon, authenticated;
revoke execute on function public.create_photo_post(text, text[], text, numeric, text) from public, anon, authenticated;
revoke execute on function public.toggle_like(uuid) from public, anon, authenticated;
revoke execute on function public.toggle_save(uuid) from public, anon, authenticated;
revoke execute on function public.create_comment(uuid, text) from public, anon, authenticated;
revoke execute on function public.create_point_request(integer, numeric, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.admin_review_point_request(uuid, boolean, text) from public, anon, authenticated;
revoke execute on function public.admin_update_user(uuid, integer, boolean) from public, anon, authenticated;
revoke execute on function public.send_private_message(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.update_post(uuid, text, text, numeric, text) from public, anon, authenticated;
revoke execute on function public.admin_update_payment_settings(text, text, text) from public, anon, authenticated;
revoke execute on function public.create_profile_for_new_user() from public, anon, authenticated;
revoke execute on function public.validate_profile_avatar() from public, anon, authenticated;
grant execute on function public.create_post(text, text, text, text, numeric, text) to authenticated;
grant execute on function public.create_photo_post(text, text[], text, numeric, text) to authenticated;
grant execute on function public.toggle_like(uuid) to authenticated;
grant execute on function public.toggle_save(uuid) to authenticated;
grant execute on function public.create_comment(uuid, text) to authenticated;
grant execute on function public.create_point_request(integer, numeric, text, text, text, text) to authenticated;
grant execute on function public.admin_review_point_request(uuid, boolean, text) to authenticated;
grant execute on function public.admin_update_user(uuid, integer, boolean) to authenticated;
grant execute on function public.send_private_message(uuid, text, uuid, text, text) to authenticated;
grant execute on function public.update_post(uuid, text, text, numeric, text) to authenticated;
grant execute on function public.admin_update_payment_settings(text, text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'marketplace-media', 'marketplace-media', true, 104857600,
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime']
)
on conflict (id) do update set public = true, file_size_limit = 104857600;

drop policy if exists "Public marketplace media is readable" on storage.objects;
create policy "Public marketplace media is readable"
on storage.objects for select to public using (bucket_id = 'marketplace-media');
drop policy if exists "Owners upload marketplace media" on storage.objects;
create policy "Owners upload marketplace media"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'marketplace-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and not public.is_marketplace_banned()
);
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'marketplace-receipts', 'marketplace-receipts', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users upload their own private receipts" on storage.objects;
create policy "Users upload their own private receipts"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'marketplace-receipts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and not public.is_marketplace_banned()
);
drop policy if exists "Owners and admins read private receipts" on storage.objects;
create policy "Owners and admins read private receipts"
on storage.objects for select to authenticated
using (
  bucket_id = 'marketplace-receipts'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or public.is_marketplace_admin()
  )
);
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'marketplace-message-media', 'marketplace-message-media', false, 20971520,
  array[
    'image/jpeg', 'image/png', 'image/webp',
    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = 20971520,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Participants upload private message media" on storage.objects;
create policy "Participants upload private message media"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'marketplace-message-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and not public.is_marketplace_banned()
);
drop policy if exists "Conversation participants read private message media" on storage.objects;
create policy "Conversation participants read private message media"
on storage.objects for select to authenticated
using (
  bucket_id = 'marketplace-message-media'
  and exists (
    select 1 from public.messages m
    where m.attachment_url = name
      and ((select auth.uid()) = m.sender_id or (select auth.uid()) = m.recipient_id)
  )
);
drop policy if exists "Owners delete their media" on storage.objects;
create policy "Owners delete their media"
on storage.objects for delete to authenticated
using (
  bucket_id = 'marketplace-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
