import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { addMemberSchema, inviteSchema, settingsSchema, updateMemberSchema } from '@ci/shared';
import { organizations } from '@ci/database';
import { addMember, createInvitation, getSettings, listInvitations, listMembers, removeMember, revokeInvitation, updateMemberRole, updateSettings } from '@ci/services';
import { HttpError, parse, requireRole } from '../app.ts';

export async function orgRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const [org] = await app.rootDb.select().from(organizations).where(eq(organizations.id, req.orgId!));
    const settings = await req.tx((tx) => getSettings(tx, req.orgId!));
    return { organization: { id: org!.id, name: org!.name, slug: org!.slug }, role: req.role, settings };
  });

  app.get('/settings', async (req) => ({ settings: await req.tx((tx) => getSettings(tx, req.orgId!)) }));

  app.put('/settings', async (req) => {
    requireRole(req, 'admin');
    const body = parse(settingsSchema, req.body);
    return { settings: await req.tx((tx) => updateSettings(tx, req.orgId!, req.user!.id, body, app.svc.clock())) };
  });

  app.get('/members', async (req) => ({ members: await listMembers(app.rootDb, req.orgId!) }));

  app.post('/members', async (req, reply) => {
    const body = parse(addMemberSchema, req.body);
    const m = await addMember(app.rootDb, req.orgId!, { role: req.role! }, body.email, body.role);
    return reply.status(201).send({ member: m });
  });

  // ── invitations: nobody joins a workspace without accepting
  app.get('/invitations', async (req) => {
    requireRole(req, 'admin');
    return { invitations: await listInvitations(app.svc, app.rootDb, req.orgId!) };
  });

  app.post('/invitations', async (req, reply) => {
    const body = parse(inviteSchema, req.body);
    const r = await createInvitation(app.svc, app.rootDb, req.orgId!, { userId: req.user!.id, role: req.role!, name: req.user!.displayName }, body);
    return reply.status(r.resent ? 200 : 201).send({ invitation: r.invitation, link: r.link, resent: r.resent });
  });

  app.post('/invitations/:invitationId/resend', async (req, reply) => {
    const { invitationId } = parse(z.object({ invitationId: z.uuid() }), req.params);
    const current = (await listInvitations(app.svc, app.rootDb, req.orgId!)).find((i) => i.id === invitationId);
    if (!current || current.status === 'accepted' || current.status === 'revoked') throw new HttpError(404, 'not_found', 'Invitation not found, or it is no longer open.');
    const r = await createInvitation(app.svc, app.rootDb, req.orgId!, { userId: req.user!.id, role: req.role!, name: req.user!.displayName }, { email: current.email, role: current.role });
    return reply.status(200).send({ invitation: r.invitation, link: r.link, resent: true });
  });

  app.delete('/invitations/:invitationId', async (req) => {
    const { invitationId } = parse(z.object({ invitationId: z.uuid() }), req.params);
    await revokeInvitation(app.svc, app.rootDb, req.orgId!, { userId: req.user!.id, role: req.role! }, invitationId);
    return { ok: true };
  });

  app.patch<{ Params: { userId: string } }>('/members/:userId', async (req) => {
    const body = parse(updateMemberSchema, req.body);
    await updateMemberRole(app.rootDb, req.orgId!, { role: req.role!, userId: req.user!.id }, req.params.userId, body.role);
    return { ok: true };
  });

  app.delete<{ Params: { userId: string } }>('/members/:userId', async (req) => {
    if (!req.params.userId) throw new HttpError(400, 'bad_request', 'Missing user');
    await removeMember(app.rootDb, req.orgId!, { role: req.role!, userId: req.user!.id }, req.params.userId);
    return { ok: true };
  });
}
