import { systemPreferences } from "electron";

export interface PermissionStatus {
  microphone: string;
  accessibility: boolean;
}

export async function checkPermissions(options?: {
  requestMicrophone?: boolean;
  promptAccessibility?: boolean;
}): Promise<PermissionStatus> {
  const requestMicrophone = options?.requestMicrophone ?? false;
  const promptAccessibility = options?.promptAccessibility ?? false;

  let microphone = systemPreferences.getMediaAccessStatus("microphone");

  if (requestMicrophone && microphone !== "granted") {
    await systemPreferences.askForMediaAccess("microphone");
    microphone = systemPreferences.getMediaAccessStatus("microphone");
  }

  const accessibility = process.platform === "darwin"
    ? systemPreferences.isTrustedAccessibilityClient(promptAccessibility)
    : false;

  return { microphone, accessibility };
}
