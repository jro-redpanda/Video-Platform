export type InvitationDeliveryInput = {
  recipientEmail: string;
  productName: string;
  workspaceName: string;
  expiresAt: Date;
  acceptUrl: string;
};
export interface InvitationDelivery {
  deliverInvitation(input: InvitationDeliveryInput): Promise<void>;
}