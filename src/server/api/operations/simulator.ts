/** Sandbox simulator controls (S8): clock, availability switches, faults, extract overlays. */
import { z } from "zod";
import { idParamSchema } from "@/contracts/common";
import {
  addReconOverlay,
  advanceClock,
  armFault,
  availabilitySchema,
  clockSchema,
  faultSchema,
  getSimulatorState,
  overlaySchema,
  removeFault,
  removeReconOverlay,
  setAvailability,
} from "@/server/domain/operations/simulator";
import { command, query, type AnyOperation } from "../framework";

type IdParams = z.infer<typeof idParamSchema>;
const base = { tag: "Sandbox simulator", scope: "bank", permission: "bank.simulator.control" } as const;
const state = async ({ deps, ctx }: { deps: Parameters<typeof getSimulatorState>[0]; ctx: Parameters<typeof getSimulatorState>[1] }) => getSimulatorState(deps, ctx);
const fixed = () => ({ type: "simulator", id: "state" });

export const simulatorOperations: AnyOperation[] = [
  query({ ...base, id: "getSimulatorState", method: "GET", path: "/bank/simulator", summary: "Sandbox clock, availability switches, armed faults and extract overlays", handler: async (request) => ({ data: await state(request) }) }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof clockSchema>>({
    ...base,
    id: "advanceSimulatorClock",
    method: "POST",
    path: "/bank/simulator/clock",
    summary: "Move the sandbox clock forward",
    description: "Sandbox-wide fixture control. Time only moves forward. Never touches a ledger or a balance.",
    body: clockSchema,
    target: fixed,
    execute: async ({ deps, ctx, body }) => advanceClock(deps, ctx, body),
    render: state,
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof availabilitySchema>>({
    ...base,
    id: "setSimulatorAvailability",
    method: "POST",
    path: "/bank/simulator/availability",
    summary: "Switch the simulated core or a simulated rail offline or online",
    body: availabilitySchema,
    target: fixed,
    execute: async ({ deps, ctx, body }) => setAvailability(deps, ctx, body),
    render: state,
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof faultSchema>>({
    ...base,
    id: "armSimulatorFault",
    method: "POST",
    path: "/bank/simulator/faults",
    summary: "Arm a one-off adapter fault for an execution of the caller's bank",
    body: faultSchema,
    successStatus: 201,
    target: fixed,
    execute: async ({ deps, ctx, body }) => armFault(deps, ctx, body),
    render: state,
  }),
  command<IdParams>({
    ...base,
    id: "removeSimulatorFault",
    method: "POST",
    path: "/bank/simulator/faults/{id}/remove",
    summary: "Remove an armed fault",
    params: idParamSchema,
    target: fixed,
    execute: async ({ deps, ctx, params }) => removeFault(deps, ctx, params.id),
    render: state,
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof overlaySchema>>({
    ...base,
    id: "addSimulatorReconOverlay",
    method: "POST",
    path: "/bank/simulator/recon-overlays",
    summary: "Make the core's reconciliation extract differ from its ledger for one reference",
    description: "Demonstrates break detection. The ledger itself is not changed.",
    body: overlaySchema,
    successStatus: 201,
    target: fixed,
    execute: async ({ deps, ctx, body }) => addReconOverlay(deps, ctx, body),
    render: state,
  }),
  command<IdParams>({
    ...base,
    id: "removeSimulatorReconOverlay",
    method: "POST",
    path: "/bank/simulator/recon-overlays/{id}/remove",
    summary: "Remove an extract overlay",
    params: idParamSchema,
    target: fixed,
    execute: async ({ deps, ctx, params }) => removeReconOverlay(deps, ctx, params.id),
    render: state,
  }),
];
