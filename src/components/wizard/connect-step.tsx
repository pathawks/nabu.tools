import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DEVICES, type DeviceDef } from "@/lib/core/devices";
import { DeviceInfoDialog } from "@/components/wizard/device-info-dialog";

const MOCK_DEVICE: DeviceDef = {
  id: "MOCK",
  name: "Mock Device",
  vendorId: null,
  productId: null,
  transport: "webusb",
  systems: [{ id: "mock", name: "Mock System" }],
  description:
    "Simulated device for browser testing. Available via the ?mock query parameter; useful for UI development without hardware attached.",
};

interface ConnectStepProps {
  onConnect: (deviceId: string) => void;
  onMockConnect: () => void;
  error: string | null;
  availableDevices: Set<string>;
}

export function ConnectStep({
  onConnect,
  onMockConnect,
  error,
  availableDevices,
}: ConnectStepProps) {
  const isMockMode = new URLSearchParams(window.location.search).has("mock");

  const transportAvailable: Record<string, boolean> = {
    serial: !!navigator.serial,
    webhid: !!navigator.hid,
    webusb: !!navigator.usb,
  };

  // Sort detected devices to the top
  const sortedDevices = useMemo(
    () =>
      [...Object.values(DEVICES)].sort(
        (a, b) =>
          (availableDevices.has(b.id) ? 1 : 0) -
          (availableDevices.has(a.id) ? 1 : 0),
      ),
    [availableDevices],
  );

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!transportAvailable.serial && !transportAvailable.webhid && (
        <Alert variant="destructive">
          <AlertDescription>
            Web Serial and WebHID APIs are not available. Use Chrome or Edge.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Supported Hardware
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            {sortedDevices.map((dev) => {
              const detected = availableDevices.has(dev.id);
              return (
                <div
                  key={dev.id}
                  className={`flex items-center justify-between rounded border p-3 ${
                    detected
                      ? "border-chart-3/40 bg-chart-3/5"
                      : "border-border"
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-card-foreground">
                        {dev.name}
                      </span>
                      {detected && (
                        <span className="flex items-center gap-1 text-[10px] font-medium text-chart-3">
                          <span className="h-1.5 w-1.5 rounded-full bg-chart-3" />
                          Detected
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {dev.systems.map((s) => s.name).join(", ")}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <DeviceInfoDialog device={dev} />
                    <Button
                      size="sm"
                      onClick={() => onConnect(dev.id)}
                      disabled={!transportAvailable[dev.transport]}
                    >
                      Connect
                    </Button>
                  </div>
                </div>
              );
            })}
            {isMockMode && (
              <div className="flex items-center justify-between rounded border border-dashed border-border p-3">
                <div>
                  <div className="text-sm font-semibold text-card-foreground">
                    Mock Device
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Simulated device for testing
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <DeviceInfoDialog device={MOCK_DEVICE} />
                  <Button size="sm" onClick={onMockConnect}>
                    Connect
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <p className="text-center text-[11px] text-muted-foreground">
        Always unplug the device before connecting or disconnecting a cartridge.
      </p>
    </div>
  );
}
