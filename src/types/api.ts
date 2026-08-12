export interface ApiResponse<T = unknown> {
  result: T;
  status?: string;
  errors?: string[];
}

export interface PaginatedResponse<T> {
  result: T[];
  next_cursor?: string;
}

export interface UserStatusesRequest {
  user_huids: string[];
  short?: boolean;
  key_id?: string;
}

export interface CtsProfilesQueryRequest {
  huids: string[];
}

export interface AdIntegrationTokenRequest {
  app_version: string;
  device: string;
  device_software: string;
  manufacturer: string;
  platform: string;
  locale: string;
  platform_package_id: string;
  device_meta: {
    pushes: boolean;
    timezone: string;
    permissions: {
      notifications: boolean;
    };
  };
  device_hostname: string | null;
}

export interface DeviceActivationRequest {
  app_version: string;
  locale: string;
  device_meta: {
    pushes: boolean;
    timezone: string;
    permissions: {
      notifications: boolean;
    };
  };
  device_hostname: string | null;
}
