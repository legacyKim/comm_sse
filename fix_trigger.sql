-- 기존 트리거와 함수 삭제
DROP TRIGGER IF EXISTS comment_trigger ON comments;
DROP FUNCTION IF EXISTS notify_comment_change();

-- 수정된 트리거 함수
CREATE OR REPLACE FUNCTION notify_comment_change() RETURNS TRIGGER AS $$
DECLARE
  profile_url TEXT;
  record_data JSON;
BEGIN
  -- INSERT, UPDATE의 경우
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    SELECT profile INTO profile_url FROM members WHERE id = NEW.user_id;
    
    record_data := json_build_object(
      'id', NEW.id,
      'post_id', NEW.post_id,
      'user_id', NEW.user_id,
      'user_nickname', NEW.user_nickname,
      'profile', profile_url,
      'parent_id', NEW.parent_id,
      'likes', NEW.likes,
      'content', NEW.content,
      'depth', NEW.depth,
      'created_at', NEW.created_at,
      'updated_at', NEW.updated_at,
      'event', TG_OP
    );
    
    PERFORM pg_notify('comment_events', record_data::text);
    RETURN NEW;
    
  -- DELETE의 경우
  ELSIF TG_OP = 'DELETE' THEN
    SELECT profile INTO profile_url FROM members WHERE id = OLD.user_id;
    
    record_data := json_build_object(
      'id', OLD.id,
      'post_id', OLD.post_id,
      'user_id', OLD.user_id,
      'user_nickname', OLD.user_nickname,
      'profile', profile_url,
      'parent_id', OLD.parent_id,
      'likes', OLD.likes,
      'content', OLD.content,
      'depth', OLD.depth,
      'created_at', OLD.created_at,
      'updated_at', OLD.updated_at,
      'event', TG_OP
    );
    
    PERFORM pg_notify('comment_events', record_data::text);
    RETURN OLD;
  END IF;
  
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 트리거 재생성
CREATE TRIGGER comment_trigger
AFTER INSERT OR DELETE OR UPDATE ON comments
FOR EACH ROW
EXECUTE FUNCTION notify_comment_change();
