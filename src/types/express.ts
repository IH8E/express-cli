export interface ExpressProfile {
  active: boolean;
  name: string;
  domain: string;
  description: string | null;
  kind: string;
  manager: string | null;
  email: string | null;
  user_huid: string;
  ad_login: string | null;
  avatar: string | null;
  company: string | null;
  company_position: string | null;
  department: string | null;
  office: string | null;
  phone: string | null;
  avatar_preview: string | null;
  ip_phone: string | null;
  other_ip_phone: string | null;
  other_phone: string | null;
  custom_avatar: string | null;
  manager_huid: string | null;
  moderation_avatar: string | null;
  custom_avatar_preview: string | null;
  moderation_avatar_preview: string | null;
}

export interface ExpressSelfProfileResponse {
  profile: ExpressProfile;
}

export type UserStatus = "online" | "offline" | "away" | "dnd" | "invisible";

export interface ExpressUserStatus {
  huid: string;
  status: UserStatus;
  last_seen?: string;
  status_text?: string;
}

export interface ExpressChat {
  group_chat_id: string;
  name: string;
  description?: string | null;
  chat_type: "group_chat" | "chat" | "channel" | "global" | "voex_call" | "notes";
  shared_history: boolean;
  avatar?: string | null;
  avatar_preview?: string | null;
  members_type?: string;
  members_count?: number;
  member_huids?: string[];
  admin_huids?: string[];
  inserted_at?: string;
  last_event_inserted_at?: string | null;
  deleted_at?: string | null;
  left?: boolean;
  active?: boolean;
}

export interface ServerMeta {
  cts_id: string;
  version: string;
  features?: Record<string, unknown>;
}

export interface SendMessageParams {
  group_chat_id: string;
  body: string;
  mentions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
