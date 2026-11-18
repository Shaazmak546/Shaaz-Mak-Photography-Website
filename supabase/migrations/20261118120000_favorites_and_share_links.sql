-- Favorites + client share links
-- ---------------------------------------------------------------------------
-- Adds (purely additive — no existing table, row or policy is changed):
--   * photos.original_filename   nullable; new uploads record the camera/Lightroom
--                                file name so print/edit picks can be matched.
--   * photo_favorites            a client's hearted photos (per user, per photo)
--   * album_shares               share links a client creates for their album
--   * album_share_photos         the photo snapshot for "favorites" / "selection" links
--   * create_album_share(...)    SECURITY INVOKER helper that creates a link + its
--                                photo snapshot atomically (RLS still applies)
--   * get_shared_album(token)    SECURITY DEFINER; the ONLY anonymous entry point.
--                                Returns just the photos the link allows.
--
-- Access model (mirrors the existing albums/photos rules):
--   * A client "owns" an album when albums.client_id = auth.uid().
--   * Clients can only heart photos / create links for albums they own.
--   * Admins (public.has_role(auth.uid(), 'admin')) can read everything and
--     revoke / delete links.
--   * anon gets NO table privileges on the new tables. The photos table is not
--     opened to anon in any way by this migration.
--   * A link stops working if it is revoked, expired, or the album is no longer
--     owned by the client who created it.
-- ---------------------------------------------------------------------------

-- 1. Original file name on photos (nullable, existing rows untouched) ---------
ALTER TABLE public.photos ADD COLUMN IF NOT EXISTS original_filename TEXT;

-- 2. Favorites ----------------------------------------------------------------
CREATE TABLE public.photo_favorites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id)     ON DELETE CASCADE,
  album_id   UUID NOT NULL REFERENCES public.albums(id)  ON DELETE CASCADE,
  photo_id   UUID NOT NULL REFERENCES public.photos(id)  ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, photo_id)
);

CREATE INDEX photo_favorites_album_user_idx ON public.photo_favorites (album_id, user_id);
CREATE INDEX photo_favorites_photo_idx      ON public.photo_favorites (photo_id);

ALTER TABLE public.photo_favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clients view own favorites; admins view all"
  ON public.photo_favorites FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- Only the album's client can heart, only their own row, and only a photo that
-- really belongs to that album.
CREATE POLICY "Clients favorite photos in their own albums"
  ON public.photo_favorites FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.photos p
      JOIN public.albums a ON a.id = p.album_id
      WHERE p.id = photo_favorites.photo_id
        AND p.album_id = photo_favorites.album_id
        AND a.client_id = auth.uid()
    )
  );

CREATE POLICY "Clients unfavorite own rows; admins can clear"
  ON public.photo_favorites FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

REVOKE ALL ON public.photo_favorites FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.photo_favorites TO authenticated;
GRANT ALL ON public.photo_favorites TO service_role;

-- 3. Share links --------------------------------------------------------------
CREATE TABLE public.album_shares (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id       UUID NOT NULL REFERENCES public.albums(id) ON DELETE CASCADE,
  created_by     UUID NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
  -- Always overwritten by the trigger below with 256 bits from two v4 UUIDs
  -- (244 random bits), base64url-encoded (43 chars).
  token          TEXT NOT NULL UNIQUE,
  mode           TEXT NOT NULL CHECK (mode IN ('album', 'favorites', 'selection')),
  allow_download BOOLEAN NOT NULL DEFAULT false,
  expires_at     TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoked_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX album_shares_album_idx      ON public.album_shares (album_id);
CREATE INDEX album_shares_created_by_idx ON public.album_shares (created_by);

CREATE TABLE public.album_share_photos (
  share_id UUID NOT NULL REFERENCES public.album_shares(id) ON DELETE CASCADE,
  photo_id UUID NOT NULL REFERENCES public.photos(id)       ON DELETE CASCADE,
  PRIMARY KEY (share_id, photo_id)
);

CREATE INDEX album_share_photos_photo_idx ON public.album_share_photos (photo_id);

-- Token + creator are set server-side; a revoke is permanent and server-timed.
CREATE OR REPLACE FUNCTION public.album_shares_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.token := rtrim(
      translate(
        encode(
          decode(
            replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
            'hex'),
          'base64'),
        '+/', '-_'),
      '=');
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
    NEW.revoked_at := NULL;
    NEW.revoked_by := NULL;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE: only revoking is meaningful (column grants restrict the rest).
  IF OLD.revoked_at IS NOT NULL THEN
    NEW.revoked_at := OLD.revoked_at;
    NEW.revoked_by := OLD.revoked_by;
  ELSIF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := now();
    NEW.revoked_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER album_shares_before_write
  BEFORE INSERT OR UPDATE ON public.album_shares
  FOR EACH ROW EXECUTE FUNCTION public.album_shares_before_write();

ALTER TABLE public.album_shares       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.album_share_photos ENABLE ROW LEVEL SECURITY;

-- album_shares policies
CREATE POLICY "Clients view own links for own albums; admins view all"
  ON public.album_shares FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (
      created_by = auth.uid()
      AND EXISTS (SELECT 1 FROM public.albums a
                  WHERE a.id = album_shares.album_id AND a.client_id = auth.uid())
    )
  );

CREATE POLICY "Clients create links for their own albums"
  ON public.album_shares FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (SELECT 1 FROM public.albums a
                WHERE a.id = album_shares.album_id AND a.client_id = auth.uid())
  );

CREATE POLICY "Clients revoke own links; admins revoke any"
  ON public.album_shares FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (
      created_by = auth.uid()
      AND EXISTS (SELECT 1 FROM public.albums a
                  WHERE a.id = album_shares.album_id AND a.client_id = auth.uid())
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR (
      created_by = auth.uid()
      AND EXISTS (SELECT 1 FROM public.albums a
                  WHERE a.id = album_shares.album_id AND a.client_id = auth.uid())
    )
  );

CREATE POLICY "Admins delete links"
  ON public.album_shares FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- album_share_photos policies
CREATE POLICY "View snapshot rows of visible links"
  ON public.album_share_photos FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.album_shares s
      JOIN public.albums a ON a.id = s.album_id
      WHERE s.id = album_share_photos.share_id
        AND s.created_by = auth.uid()
        AND a.client_id = auth.uid()
    )
  );

CREATE POLICY "Clients add own album photos to own active links"
  ON public.album_share_photos FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.album_shares s
      JOIN public.albums a ON a.id = s.album_id
      JOIN public.photos p ON p.album_id = s.album_id
      WHERE s.id = album_share_photos.share_id
        AND p.id = album_share_photos.photo_id
        AND s.created_by = auth.uid()
        AND a.client_id = auth.uid()
        AND s.revoked_at IS NULL
    )
  );

CREATE POLICY "Admins delete snapshot rows"
  ON public.album_share_photos FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

REVOKE ALL ON public.album_shares       FROM anon, authenticated;
REVOKE ALL ON public.album_share_photos FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.album_shares TO authenticated;
GRANT UPDATE (revoked_at)    ON public.album_shares TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.album_share_photos TO authenticated;
GRANT ALL ON public.album_shares       TO service_role;
GRANT ALL ON public.album_share_photos TO service_role;

-- 4. create_album_share: one call creates the link + its photo snapshot. -------
-- SECURITY INVOKER on purpose: every insert goes through the RLS above.
CREATE OR REPLACE FUNCTION public.create_album_share(
  p_album_id        UUID,
  p_mode            TEXT,
  p_photo_ids       UUID[]  DEFAULT NULL,
  p_expires_in_days INTEGER DEFAULT NULL,
  p_allow_download  BOOLEAN DEFAULT false
)
RETURNS TABLE (id UUID, token TEXT, expires_at TIMESTAMPTZ, photo_count INTEGER)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_share   public.album_shares%ROWTYPE;
  v_wanted  INTEGER;
  v_count   INTEGER := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in required' USING ERRCODE = '42501';
  END IF;
  IF p_mode NOT IN ('album', 'favorites', 'selection') THEN
    RAISE EXCEPTION 'Invalid share mode' USING ERRCODE = '22023';
  END IF;
  IF p_expires_in_days IS NOT NULL AND (p_expires_in_days < 1 OR p_expires_in_days > 365) THEN
    RAISE EXCEPTION 'Invalid expiry' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.album_shares (album_id, created_by, token, mode, allow_download, expires_at)
  VALUES (
    p_album_id,
    auth.uid(),
    'pending',  -- replaced by trigger
    p_mode,
    COALESCE(p_allow_download, false),
    CASE WHEN p_expires_in_days IS NULL THEN NULL
         ELSE now() + make_interval(days => p_expires_in_days) END
  )
  RETURNING * INTO v_share;

  IF p_mode = 'favorites' THEN
    INSERT INTO public.album_share_photos (share_id, photo_id)
    SELECT v_share.id, f.photo_id
    FROM public.photo_favorites f
    JOIN public.photos p ON p.id = f.photo_id AND p.album_id = p_album_id
    WHERE f.user_id = auth.uid() AND f.album_id = p_album_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 0 THEN
      RAISE EXCEPTION 'You have no favorites in this album yet' USING ERRCODE = '22023';
    END IF;

  ELSIF p_mode = 'selection' THEN
    SELECT count(DISTINCT x) INTO v_wanted FROM unnest(COALESCE(p_photo_ids, '{}')) AS x;
    IF v_wanted = 0 THEN
      RAISE EXCEPTION 'Choose at least one photo' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.album_share_photos (share_id, photo_id)
    SELECT DISTINCT v_share.id, p.id
    FROM public.photos p
    WHERE p.album_id = p_album_id AND p.id = ANY (p_photo_ids);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> v_wanted THEN
      RAISE EXCEPTION 'Some photos are not in this album' USING ERRCODE = '22023';
    END IF;

  ELSE
    SELECT count(*) INTO v_count FROM public.photos p WHERE p.album_id = p_album_id;
  END IF;

  RETURN QUERY SELECT v_share.id, v_share.token, v_share.expires_at, v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.create_album_share(UUID, TEXT, UUID[], INTEGER, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_album_share(UUID, TEXT, UUID[], INTEGER, BOOLEAN) TO authenticated, service_role;

-- 5. get_shared_album: the only anonymous read path. -------------------------
-- Returns jsonb: { status: 'ok' | 'not_found' | 'expired' | 'revoked', ... }.
-- Original (full-res) URLs are only returned when the link allows downloads;
-- otherwise any "variant" that is really the original URL is blanked out too.
CREATE OR REPLACE FUNCTION public.get_shared_album(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_share  public.album_shares%ROWTYPE;
  v_album  public.albums%ROWTYPE;
  v_photos JSONB;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 OR length(p_token) > 100 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO v_share FROM public.album_shares s WHERE s.token = p_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO v_album FROM public.albums a WHERE a.id = v_share.album_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_share.revoked_at IS NOT NULL
     OR NOT (v_album.client_id = v_share.created_by OR public.has_role(v_share.created_by, 'admin')) THEN
    RETURN jsonb_build_object('status', 'revoked');
  END IF;

  IF v_share.expires_at IS NOT NULL AND v_share.expires_at <= now() THEN
    RETURN jsonb_build_object('status', 'expired');
  END IF;

  WITH chosen AS (
    SELECT p.*
    FROM public.photos p
    WHERE p.album_id = v_share.album_id
      AND (
        v_share.mode = 'album'
        OR EXISTS (SELECT 1 FROM public.album_share_photos sp
                   WHERE sp.share_id = v_share.id AND sp.photo_id = p.id)
      )
  )
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'id',            c.id,
             'thumbnail_url', CASE WHEN v_share.allow_download OR c.thumbnail_url IS DISTINCT FROM c.url
                                   THEN c.thumbnail_url END,
             'preview_url',   CASE WHEN v_share.allow_download OR c.preview_url IS DISTINCT FROM c.url
                                   THEN c.preview_url END,
             'url',           CASE WHEN v_share.allow_download THEN c.url END,
             'width',         c.width,
             'height',        c.height
           )
           ORDER BY c.sort_order NULLS LAST, c.created_at, c.id
         ), '[]'::jsonb)
  INTO v_photos
  FROM chosen c;

  RETURN jsonb_build_object(
    'status',         'ok',
    'album_title',    v_album.title,
    'mode',           v_share.mode,
    'allow_download', v_share.allow_download,
    'expires_at',     v_share.expires_at,
    'photos',         v_photos
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_shared_album(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_album(TEXT) TO anon, authenticated, service_role;
