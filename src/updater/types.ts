export type InstallUpdateMode =
  | "selfUpdate"
  | "packageManaged"
  | "development";

export type UpdateDetails = {
  version: string;
  title: string;
  summary: string;
  highlights: string[];
  releaseUrl: string;
};

export type UpdateState =
  | { status: "idle" | "checking" | "upToDate" }
  | {
      status: "downloading";
      version: string;
      downloaded: number;
      total?: number;
    }
  | ({ status: "ready" | "packageManaged" } & UpdateDetails)
  | { status: "installing"; version: string }
  | {
      status: "error";
      stage: "check" | "download" | "install";
      message: string;
    };

export type AppUpdaterController = {
  enabled: boolean;
  state: UpdateState;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  openRelease: () => Promise<void>;
};
