/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import {
  AseaResourceType,
  DnsFirewallRuleGroupConfig,
  DnsQueryLogsConfig,
  IpamAllocationConfig,
  IpamPoolConfig,
  NetworkAclSubnetSelection,
  NfwFirewallConfig,
  NfwFirewallPolicyConfig,
  NfwRuleGroupConfig,
  PrefixListConfig,
  ResolverRuleConfig,
  RouteTableEntryConfig,
  SecurityGroupConfig,
  SubnetConfig,
  TransitGatewayAttachmentConfig,
  TransitGatewayConfig,
  VpcConfig,
  VpcTemplatesConfig,
  VpnConnectionConfig,
} from '@aws-accelerator/config';
import {
  IIpamSubnet,
  IResourceShareItem,
  IpamSubnet,
  PrefixList,
  ResourceShare,
  ResourceShareItem,
  ResourceShareOwner,
  SecurityGroup,
  SecurityGroupEgressRuleProps,
  SecurityGroupIngressRuleProps,
  SsmParameterLookup,
  Subnet,
  Vpc,
  VpnConnectionProps,
  VpnTunnelOptionsSpecifications,
} from '@aws-accelerator/constructs';
import { SsmResourceType } from '@aws-accelerator/utils';
import * as cdk from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { pascalCase } from 'pascal-case';
import {
  AcceleratorKeyType,
  AcceleratorStack,
  AcceleratorStackProps,
  NagSuppressionDetailType,
} from '../accelerator-stack';
import { getSecurityGroup, getVpc } from './utils/getter-utils';
import {
  containsAllIngressRule,
  processSecurityGroupEgressRules,
  processSecurityGroupIngressRules,
  processSecurityGroupSgEgressSources,
  processSecurityGroupSgIngressSources,
} from './utils/security-group-utils';
import { hasAdvancedVpnOptions } from './utils/validation-utils';

/**
 * Resource share type for RAM resource shares
 */
type ResourceShareType =
  | DnsFirewallRuleGroupConfig
  | DnsQueryLogsConfig
  | IpamPoolConfig
  | NfwRuleGroupConfig
  | NfwFirewallPolicyConfig
  | SubnetConfig
  | ResolverRuleConfig
  | TransitGatewayConfig;

/**
 * Enum for log level
 */
export enum LogLevel {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

/**
 * Abstract class definition and methods for network stacks
 */
export abstract class NetworkStack extends AcceleratorStack {
  /**
   * The accelerator prefix value
   */
  public readonly acceleratorPrefix: string;
  /**
   * Cloudwatch KMS key
   */
  public readonly cloudwatchKey: cdk.aws_kms.Key;
  /**
   * Flag to determine if there is an advanced VPN in scope of the current stack context
   */
  public readonly containsAdvancedVpn: boolean;
  /**
   * KMS Key used to encrypt custom resource lambda environment variables
   */
  public readonly lambdaKey: cdk.aws_kms.Key;
  /**
   * Global CloudWatch logs retention setting
   */
  public readonly logRetention: number;
  /**
   * VPCs with subnets shared via Resource Access Manager (RAM) in scope of the current stack context
   */
  public readonly sharedVpcs: (VpcConfig | VpcTemplatesConfig)[];
  /**
   * VPCs and VPC templates in scope of the current stack context
   */
  public readonly vpcsInScope: (VpcConfig | VpcTemplatesConfig)[];
  /**
   * All VPC and VPC template resources in the network configuration
   */
  public readonly vpcResources: (VpcConfig | VpcTemplatesConfig)[];

  protected nagSuppressionInputs: NagSuppressionDetailType[] = [];

  protected constructor(scope: Construct, id: string, props: AcceleratorStackProps) {
    super(scope, id, props);

    // Set properties
    this.acceleratorPrefix = props.prefixes.accelerator;
    this.containsAdvancedVpn = this.setAdvancedVpnFlag(props);
    this.logRetention = props.globalConfig.cloudwatchLogRetentionInDays;
    this.vpcResources = [...props.networkConfig.vpcs, ...(props.networkConfig.vpcTemplates ?? [])];
    this.sharedVpcs = this.getSharedVpcs(this.vpcResources);
    this.vpcsInScope = this.getVpcsInScope(this.vpcResources);

    this.cloudwatchKey = this.getAcceleratorKey(AcceleratorKeyType.CLOUDWATCH_KEY);
    this.lambdaKey = this.getAcceleratorKey(AcceleratorKeyType.LAMBDA_KEY);
  }

  /**
   *
   *
   *        Network Stack helper methods
   *
   */

  /**
   * Get VPCs with shared subnets in scope of the current stack context
   * @param vpcResources
   * @returns
   */
  private getSharedVpcs(vpcResources: (VpcConfig | VpcTemplatesConfig)[]): (VpcConfig | VpcTemplatesConfig)[] {
    const sharedVpcs: (VpcConfig | VpcTemplatesConfig)[] = [];

    for (const vpcItem of vpcResources) {
      const accountIds: string[] = [];
      const sharedSubnets = vpcItem.subnets ? vpcItem.subnets.filter(subnet => subnet.shareTargets) : [];
      const vpcAccountIds = this.getVpcAccountIds(vpcItem);

      for (const subnetItem of sharedSubnets) {
        const subnetAccountIds = this.getAccountIdsFromShareTarget(subnetItem.shareTargets!);
        subnetAccountIds.forEach(accountId => {
          if (!accountIds.includes(accountId) && !vpcAccountIds.includes(accountId)) {
            accountIds.push(accountId);
          }
        });
      }
      // Add VPC to array if it has shared subnets in scope of the current stack
      if (this.isTargetStack(accountIds, [vpcItem.region])) {
        sharedVpcs.push(vpcItem);
      }
    }
    return sharedVpcs;
  }
  /**
   * Get VPCs in current scope of the stack context
   * @param vpcResources
   * @returns
   */
  private getVpcsInScope(vpcResources: (VpcConfig | VpcTemplatesConfig)[]): (VpcConfig | VpcTemplatesConfig)[] {
    const vpcsInScope: (VpcConfig | VpcTemplatesConfig)[] = [];

    for (const vpcItem of vpcResources) {
      const vpcAccountIds = this.getVpcAccountIds(vpcItem);

      if (this.isTargetStack(vpcAccountIds, [vpcItem.region])) {
        vpcsInScope.push(vpcItem);
      }
    }
    return vpcsInScope;
  }

  /**
   * Determines if any of the VPN connections require advanced configuration options.
   * @param props AcceleratorStackProps
   * @returns boolean
   */
  private setAdvancedVpnFlag(props: AcceleratorStackProps): boolean {
    for (const cgw of props.networkConfig.customerGateways ?? []) {
      const cgwAccount = props.accountsConfig.getAccountId(cgw.account);
      for (const vpnItem of cgw.vpnConnections ?? []) {
        if (this.isTargetStack([cgwAccount], [cgw.region]) && hasAdvancedVpnOptions(vpnItem)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Returns true if provided account ID and region parameters match contextual values for the current stack
   * @param accountIds
   * @param regions
   * @returns
   */
  public isTargetStack(accountIds: string[], regions: string[]): boolean {
    return accountIds.includes(cdk.Stack.of(this).account) && regions.includes(cdk.Stack.of(this).region);
  }

  /**
   * Public Get account and region deployment targets for prefix lists
   * @param prefixListItem
   */
  public getPrefixListTargets(prefixListItem: PrefixListConfig): { accountIds: string[]; regions: string[] } {
    // Check if the set belongs in this account/region
    if (prefixListItem.accounts && prefixListItem.deploymentTargets) {
      this.logger.error(
        `prefix list ${prefixListItem.name} has both accounts and deploymentTargets defined. Please use deploymentTargets only.`,
      );
      throw new Error(`Configuration validation failed at runtime.`);
    }

    const accountIds = [];
    const regions = [];
    if (prefixListItem.accounts && prefixListItem.regions) {
      // Check if the set belongs in this account/region
      accountIds.push(
        ...prefixListItem.accounts.map(item => {
          return this.props.accountsConfig.getAccountId(item);
        }),
      );
      regions.push(
        ...prefixListItem.regions.map(item => {
          return item.toString();
        }),
      );
    }
    if (prefixListItem.deploymentTargets) {
      accountIds.push(...this.getAccountIdsFromDeploymentTarget(prefixListItem.deploymentTargets));
      regions.push(...this.getRegionsFromDeploymentTarget(prefixListItem.deploymentTargets));
    }
    if (accountIds.length === 0) {
      throw new Error(`No account targets specified for prefix list ${prefixListItem.name}`);
    }
    if (regions.length === 0) {
      throw new Error(`No region targets specified for prefix list ${prefixListItem.name}`);
    }

    return { accountIds, regions };
  }
  /**
   * Public accessor method to add logs to logger
   * @param logLevel
   * @param message
   */
  public addLogs(logLevel: LogLevel, message: string) {
    switch (logLevel) {
      case 'info':
        this.logger.info(message);
        break;

      case 'warn':
        this.logger.warn(message);
        break;

      case 'error':
        this.logger.error(message);
        break;
    }
  }

  /**
   * Returns a map of VPC IDs for the target stack
   * @param vpcResources
   * @returns
   */
  protected setVpcMap(vpcResources: (VpcConfig | VpcTemplatesConfig)[]): Map<string, string> {
    const vpcMap = new Map<string, string>();

    for (const vpcItem of vpcResources) {
      const vpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.VPC, [vpcItem.name]),
      );
      vpcMap.set(vpcItem.name, vpcId);
    }
    return vpcMap;
  }

  /**
   * Returns a map of subnet IDs for the target stack
   * @param vpcResources
   * @returns
   */
  protected setSubnetMap(vpcResources: (VpcConfig | VpcTemplatesConfig)[]): Map<string, string> {
    const subnetMap = new Map<string, string>();

    for (const vpcItem of vpcResources) {
      for (const subnetItem of vpcItem.subnets ?? []) {
        const subnetId = cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          this.getSsmPath(SsmResourceType.SUBNET, [vpcItem.name, subnetItem.name]),
        );
        subnetMap.set(`${vpcItem.name}_${subnetItem.name}`, subnetId);
      }
    }
    return subnetMap;
  }

  /**
   * Returns a map of route table IDs for the target stack
   * @param vpcResources
   * @returns
   */
  protected setRouteTableMap(vpcResources: (VpcConfig | VpcTemplatesConfig)[]): Map<string, string> {
    const routeTableMap = new Map<string, string>();

    for (const vpcItem of vpcResources) {
      for (const routeTableItem of vpcItem.routeTables ?? []) {
        const routeTableId = cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          this.getSsmPath(SsmResourceType.ROUTE_TABLE, [vpcItem.name, routeTableItem.name]),
        );
        routeTableMap.set(`${vpcItem.name}_${routeTableItem.name}`, routeTableId);
      }
    }
    return routeTableMap;
  }

  /**
   * Returns a map of security group IDs for the target stack
   * @param vpcResources
   * @returns
   */
  protected setSecurityGroupMap(vpcResources: (VpcConfig | VpcTemplatesConfig)[]): Map<string, string> {
    const securityGroupMap = new Map<string, string>();

    for (const vpcItem of vpcResources) {
      for (const securityGroupItem of vpcItem.securityGroups ?? []) {
        const securityGroupId = cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          this.getSsmPath(SsmResourceType.SECURITY_GROUP, [vpcItem.name, securityGroupItem.name]),
        );
        securityGroupMap.set(`${vpcItem.name}_${securityGroupItem.name}`, securityGroupId);
      }
    }
    return securityGroupMap;
  }

  /**
   * Returns a map of transit gateway resources being targeted based on the
   * attachments for VPCs in a given stack
   * @param vpcResources
   * @returns
   */
  public setVpcTransitGatewayMap(vpcResources: (VpcConfig | VpcTemplatesConfig)[]): Map<string, string> {
    const transitGatewayMap = new Map<string, string>();

    for (const vpcItem of vpcResources) {
      for (const attachment of vpcItem.transitGatewayAttachments ?? []) {
        // If the map does not have the TGW ID, set it
        if (!transitGatewayMap.has(attachment.transitGateway.name)) {
          transitGatewayMap.set(attachment.transitGateway.name, this.getTransitGatewayItem(attachment));
        }
      }
    }
    return transitGatewayMap;
  }

  /**
   * Returns the transit gateway ID for a given VPC attachment
   * @param attachment
   */
  protected getTransitGatewayItem(attachment: TransitGatewayAttachmentConfig): string {
    const owningAccountId = this.props.accountsConfig.getAccountId(attachment.transitGateway.account);
    let tgwId: string;
    // If owning account is this account, transit gateway id can be
    // retrieved from ssm parameter store
    if (owningAccountId === cdk.Stack.of(this).account) {
      tgwId = cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.TGW, [attachment.transitGateway.name]),
      );
    }
    // Else, need to get the transit gateway from the resource shares
    else {
      // Get the resource share related to the transit gateway
      tgwId = this.getResourceShare(
        `${attachment.transitGateway.name}_TransitGatewayShare`,
        'ec2:TransitGateway',
        owningAccountId,
        this.cloudwatchKey,
      ).resourceShareItemId;
    }
    return tgwId;
  }

  /**
   * Returns maps of DNS zone details if central interface endpoint VPC is enabled in the target stack
   * @param vpcResources
   * @returns
   */
  protected setInterfaceEndpointDnsMap(vpcResources: (VpcConfig | VpcTemplatesConfig)[]): Map<string, string>[] {
    const endpointMap = new Map<string, string>();
    const zoneMap = new Map<string, string>();

    for (const vpcItem of vpcResources) {
      if (vpcItem.interfaceEndpoints?.central) {
        // Set interface endpoint DNS names
        for (const endpointItem of vpcItem.interfaceEndpoints?.endpoints ?? []) {
          const endpointDns = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.getSsmPath(SsmResourceType.ENDPOINT_DNS, [vpcItem.name, endpointItem.service]),
          );
          const zoneId = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.getSsmPath(SsmResourceType.ENDPOINT_ZONE_ID, [vpcItem.name, endpointItem.service]),
          );
          endpointMap.set(`${vpcItem.name}_${endpointItem.service}`, endpointDns);
          zoneMap.set(`${vpcItem.name}_${endpointItem.service}`, zoneId);
        }
      }
    }
    return [endpointMap, zoneMap];
  }

  /**
   * Returns a map of Route 53 resolver endpoint IDs if enabled in the target stack
   * @param vpcResources
   */
  protected setResolverEndpointMap(vpcResources: (VpcConfig | VpcTemplatesConfig)[]): Map<string, string> {
    const endpointMap = new Map<string, string>();

    for (const vpcItem of vpcResources) {
      if (this.props.networkConfig.centralNetworkServices?.route53Resolver?.endpoints) {
        const endpoints = this.props.networkConfig.centralNetworkServices?.route53Resolver?.endpoints;

        for (const endpointItem of endpoints) {
          // Only map endpoints for relevant VPCs
          if (endpointItem.vpc === vpcItem.name) {
            const endpointId = cdk.aws_ssm.StringParameter.valueForStringParameter(
              this,
              this.getSsmPath(SsmResourceType.RESOLVER_ENDPOINT, [endpointItem.name]),
            );
            endpointMap.set(`${vpcItem.name}_${endpointItem.name}`, endpointId);
          }
        }
      }
    }
    return endpointMap;
  }

  /**
   * Function to create MAP of FW policy and policy ARN
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param firewalls {@link NfwFirewallConfig}[]
   * @param policyMap Map<string, string>
   * @param props {@link AcceleratorStackProps}
   */
  private createFwPolicyMap(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    firewalls: NfwFirewallConfig[],
    policyMap: Map<string, string>,
    props: AcceleratorStackProps,
  ) {
    const delegatedAdminAccountId = this.props.accountsConfig.getAccountId(
      props.networkConfig.centralNetworkServices!.delegatedAdminAccount,
    );
    for (const firewallItem of firewalls) {
      if (firewallItem.vpc === vpcItem.name && !policyMap.has(firewallItem.firewallPolicy)) {
        // Get firewall policy ARN
        let policyArn: string;

        if (
          delegatedAdminAccountId === cdk.Stack.of(this).account ||
          this.isManagedByAsea(AseaResourceType.NFW, firewallItem.name)
        ) {
          policyArn = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.getSsmPath(SsmResourceType.NFW_POLICY, [firewallItem.firewallPolicy]),
          );
        } else {
          policyArn = this.getResourceShare(
            `${firewallItem.firewallPolicy}_NetworkFirewallPolicyShare`,
            'network-firewall:FirewallPolicy',
            delegatedAdminAccountId,
            this.cloudwatchKey,
          ).resourceShareItemArn;
        }
        policyMap.set(firewallItem.firewallPolicy, policyArn);
      }
    }
  }

  /**
   * Set Network Firewall policy map
   * @param props
   * @returns
   */
  protected setNfwPolicyMap(props: AcceleratorStackProps): Map<string, string> {
    const policyMap = new Map<string, string>();

    if (props.networkConfig.centralNetworkServices?.networkFirewall?.firewalls) {
      const firewalls = props.networkConfig.centralNetworkServices?.networkFirewall?.firewalls;

      for (const vpcItem of this.vpcResources) {
        // Get account IDs
        const vpcAccountIds = this.getVpcAccountIds(vpcItem);

        if (this.isTargetStack(vpcAccountIds, [vpcItem.region])) {
          this.createFwPolicyMap(vpcItem, firewalls, policyMap, props);
        }
      }
    }
    return policyMap;
  }

  /**
   * Get the resource ID from a RAM share.
   *
   * @param resourceShareName
   * @param itemType
   * @param owningAccountId
   */
  protected getResourceShare(
    resourceShareName: string,
    itemType: string,
    owningAccountId: string,
    kmsKey: cdk.aws_kms.Key,
    vpcName?: string,
  ): IResourceShareItem {
    // Generate a logical ID
    const resourceName = resourceShareName.split('_')[0];
    const logicalId = vpcName
      ? `${vpcName}${resourceName}${itemType.split(':')[1]}`
      : `${resourceName}${itemType.split(':')[1]}`;

    // Lookup resource share
    const resourceShare = ResourceShare.fromLookup(this, pascalCase(`${logicalId}Share`), {
      resourceShareOwner: ResourceShareOwner.OTHER_ACCOUNTS,
      resourceShareName: resourceShareName,
      owningAccountId,
    });

    // Represents the item shared by RAM
    return ResourceShareItem.fromLookup(this, pascalCase(`${logicalId}`), {
      resourceShare,
      resourceShareItemType: itemType,
      kmsKey,
      logRetentionInDays: this.logRetention,
    });
  }

  /**
   * Add RAM resource shares to the stack.
   *
   * @param item
   * @param resourceShareName
   * @param resourceArns
   */
  public addResourceShare(item: ResourceShareType, resourceShareName: string, resourceArns: string[]) {
    // Build a list of principals to share to
    const principals: string[] = [];

    // Loop through all the defined OUs
    for (const ouItem of item.shareTargets?.organizationalUnits ?? []) {
      let ouArn = this.props.organizationConfig.getOrganizationalUnitArn(ouItem);
      // AWS::RAM::ResourceShare expects the organizations ARN if
      // sharing with the entire org (Root)
      if (ouItem === 'Root') {
        ouArn = ouArn.substring(0, ouArn.lastIndexOf('/')).replace('root', 'organization');
      }
      this.logger.info(`Share ${resourceShareName} with Organizational Unit ${ouItem}: ${ouArn}`);
      principals.push(ouArn);
    }

    // Loop through all the defined accounts
    for (const account of item.shareTargets?.accounts ?? []) {
      const accountId = this.props.accountsConfig.getAccountId(account);
      this.logger.info(`Share ${resourceShareName} with Account ${account}: ${accountId}`);
      principals.push(accountId);
    }

    // Create the Resource Share
    new ResourceShare(this, `${pascalCase(resourceShareName)}ResourceShare`, {
      name: resourceShareName,
      principals,
      resourceArns: resourceArns,
    });
  }

  /**
   * Returns true if the NACL resource is referencing a cross-account subnet
   * @param naclItem
   * @returns
   */
  public isIpamCrossAccountNaclSource(naclItem: string | NetworkAclSubnetSelection): boolean {
    if (typeof naclItem === 'string') {
      return false;
    }
    const accountId = cdk.Stack.of(this).account;
    const naclAccount = naclItem.account ? this.props.accountsConfig.getAccountId(naclItem.account) : accountId;
    const region = cdk.Stack.of(this).region;
    const naclRegion = naclItem.region;

    const crossAccountCondition = naclRegion
      ? accountId !== naclAccount || region !== naclRegion
      : accountId !== naclAccount;

    if (crossAccountCondition) {
      const vpcItem = this.vpcResources.find(item => item.name === naclItem.vpc);
      if (!vpcItem) {
        this.logger.error(`Specified VPC ${naclItem.vpc} not defined`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      const subnetItem = vpcItem.subnets?.find(item => item.name === naclItem.subnet);
      if (!subnetItem) {
        this.logger.error(`Specified subnet ${naclItem.subnet} not defined`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      if (subnetItem.ipamAllocation) {
        return true;
      } else {
        return false;
      }
    } else {
      return false;
    }
  }

  /**
   * Function to create IPAM pool map of pool name and pool id
   * @param ipamAllocations {@link IpamAllocationConfig}[]
   * @param poolMap Map<string, string>,
   * @param props {@link AcceleratorStackProps}
   */
  private createIpamPoolMap(
    ipamAllocations: IpamAllocationConfig[],
    poolMap: Map<string, string>,
    props: AcceleratorStackProps,
  ) {
    const delegatedAdminAccountId = props.accountsConfig.getAccountId(
      props.networkConfig.centralNetworkServices!.delegatedAdminAccount,
    );
    for (const alloc of ipamAllocations) {
      const ipamPool = props.networkConfig.centralNetworkServices!.ipams?.find(item =>
        item.pools?.find(item => item.name === alloc.ipamPoolName),
      );
      if (ipamPool === undefined) {
        this.logger.error(`Specified Ipam Pool not defined`);
        throw new Error(`Configuration validation failed at runtime.`);
      }
      if (!poolMap.has(alloc.ipamPoolName)) {
        let poolId: string;
        if (delegatedAdminAccountId === cdk.Stack.of(this).account && ipamPool.region === cdk.Stack.of(this).region) {
          poolId = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.getSsmPath(SsmResourceType.IPAM_POOL, [alloc.ipamPoolName]),
          );
        } else if (ipamPool.region !== cdk.Stack.of(this).region) {
          poolId = this.getCrossRegionPoolId(delegatedAdminAccountId, alloc.ipamPoolName, ipamPool.region);
        } else {
          poolId = this.getResourceShare(
            `${alloc.ipamPoolName}_IpamPoolShare`,
            'ec2:IpamPool',
            delegatedAdminAccountId,
            this.cloudwatchKey,
          ).resourceShareItemId;
        }
        poolMap.set(alloc.ipamPoolName, poolId);
      }
    }
  }

  /**
   * Set IPAM pool map
   * @param props
   * @returns
   */
  protected setIpamPoolMap(props: AcceleratorStackProps): Map<string, string> {
    const poolMap = new Map<string, string>();

    if (props.networkConfig.centralNetworkServices?.ipams) {
      for (const vpcItem of this.vpcsInScope) {
        this.createIpamPoolMap(vpcItem.ipamAllocations ?? [], poolMap, props);
      }
    }
    return poolMap;
  }

  /**
   * Method to retrieve IPAM Pool ID from cross-region
   * @param delegatedAdminAccountId
   * @param poolName
   * @param ipamPoolRegion
   */
  private getCrossRegionPoolId(delegatedAdminAccountId: string, poolName: string, ipamPoolRegion: string): string {
    let poolId: string | undefined = undefined;
    if (delegatedAdminAccountId !== cdk.Stack.of(this).account) {
      poolId = new SsmParameterLookup(this, pascalCase(`SsmParamLookup${poolName}`), {
        name: this.getSsmPath(SsmResourceType.IPAM_POOL, [poolName]),
        accountId: delegatedAdminAccountId,
        parameterRegion: ipamPoolRegion,
        roleName: this.acceleratorResourceNames.roles.ipamSsmParameterAccess,
        kmsKey: this.cloudwatchKey,
        logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays ?? 365,
        acceleratorPrefix: this.props.prefixes.accelerator,
      }).value;
    } else {
      poolId = new SsmParameterLookup(this, pascalCase(`SsmParamLookup${poolName}`), {
        name: this.getSsmPath(SsmResourceType.IPAM_POOL, [poolName]),
        accountId: delegatedAdminAccountId,
        parameterRegion: ipamPoolRegion,
        acceleratorPrefix: this.props.prefixes.accelerator,
      }).value;
    }
    return poolId;
  }

  /**
   * Create security group resources
   * @param vpcResources
   * @param vpcMap
   * @param subnetMap
   * @param prefixListMap
   * @returns
   */
  public createSecurityGroups(
    vpcResources: (VpcConfig | VpcTemplatesConfig)[],
    vpcMap: Map<string, Vpc> | Map<string, string>,
    subnetMap: Map<string, Subnet> | Map<string, IIpamSubnet>,
    prefixListMap: Map<string, PrefixList> | Map<string, string>,
  ): Map<string, SecurityGroup> {
    const securityGroupMap = new Map<string, SecurityGroup>();

    for (const vpcItem of vpcResources) {
      for (const securityGroupItem of vpcItem.securityGroups ?? []) {
        this.logger.info(`Processing rules for ${securityGroupItem.name} in VPC ${vpcItem.name}`);

        // Process configured rules
        const processedIngressRules = processSecurityGroupIngressRules(
          this.vpcResources,
          securityGroupItem,
          subnetMap,
          prefixListMap,
        );
        const allIngressRule = containsAllIngressRule(processedIngressRules);
        const processedEgressRules = processSecurityGroupEgressRules(
          this.vpcResources,
          securityGroupItem,
          subnetMap,
          prefixListMap,
        );

        // Get VPC
        const vpc = getVpc(vpcMap, vpcItem.name);

        // Create security group
        const securityGroup = this.createSecurityGroupItem(
          vpcItem,
          vpc,
          securityGroupItem,
          processedIngressRules,
          processedEgressRules,
          allIngressRule,
        );
        securityGroupMap.set(`${vpcItem.name}_${securityGroupItem.name}`, securityGroup);
      }
      // Create security group rules that reference other security groups
      this.createSecurityGroupSgSources(vpcItem, subnetMap, prefixListMap, securityGroupMap);
    }
    return securityGroupMap;
  }

  /**
   * Create security group rules that reference other security groups
   * @param vpcItem
   * @param subnetMap
   * @param prefixListMap
   * @param securityGroupMap
   */
  private createSecurityGroupSgSources(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    subnetMap: Map<string, Subnet> | Map<string, IIpamSubnet>,
    prefixListMap: Map<string, PrefixList> | Map<string, string>,
    securityGroupMap: Map<string, SecurityGroup>,
  ) {
    for (const securityGroupItem of vpcItem.securityGroups ?? []) {
      const isSecurityGroupExternal = this.isManagedByAsea(
        AseaResourceType.EC2_SECURITY_GROUP,
        `${vpcItem.name}/${securityGroupItem.name}`,
      );
      const securityGroup = getSecurityGroup(securityGroupMap, vpcItem.name, securityGroupItem.name) as SecurityGroup;
      const ingressRules = processSecurityGroupSgIngressSources(
        this.vpcResources,
        vpcItem,
        securityGroupItem,
        subnetMap,
        prefixListMap,
        securityGroupMap,
      );
      const egressRules = processSecurityGroupSgEgressSources(
        this.vpcResources,
        vpcItem,
        securityGroupItem,
        subnetMap,
        prefixListMap,
        securityGroupMap,
      );

      // Create ingress rules
      ingressRules.forEach(ingressRule => {
        if (isSecurityGroupExternal) return;
        securityGroup.addIngressRule(ingressRule.logicalId, {
          sourceSecurityGroup: ingressRule.rule.targetSecurityGroup,
          ...ingressRule.rule,
        });
      });

      // Create egress rules
      egressRules.forEach(egressRule => {
        if (isSecurityGroupExternal) return;
        securityGroup.addEgressRule(egressRule.logicalId, {
          destinationSecurityGroup: egressRule.rule.targetSecurityGroup,
          ...egressRule.rule,
        });
      });
    }
  }

  /**
   * Create a security group item
   * @param vpcItem
   * @param vpc
   * @param securityGroupItem
   * @param processedIngressRules
   * @param processedEgressRules
   * @param allIngressRule
   * @returns
   */
  private createSecurityGroupItem(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpc: Vpc | string,
    securityGroupItem: SecurityGroupConfig,
    processedIngressRules: SecurityGroupIngressRuleProps[],
    processedEgressRules: SecurityGroupEgressRuleProps[],
    allIngressRule: boolean,
  ): SecurityGroup {
    this.logger.info(`Adding Security Group ${securityGroupItem.name} in VPC ${vpcItem.name}`);
    let securityGroup;
    if (this.isManagedByAsea(AseaResourceType.EC2_SECURITY_GROUP, `${vpcItem.name}/${securityGroupItem.name}`)) {
      const securityGroupId = this.getExternalResourceParameter(
        this.getSsmPath(SsmResourceType.SECURITY_GROUP, [vpcItem.name, securityGroupItem.name]),
      );
      securityGroup = SecurityGroup.fromSecurityGroupId(this, securityGroupId);
    } else {
      securityGroup = new SecurityGroup(
        this,
        pascalCase(`${vpcItem.name}Vpc`) + pascalCase(`${securityGroupItem.name}Sg`),
        {
          securityGroupName: securityGroupItem.name,
          securityGroupEgress: processedEgressRules,
          securityGroupIngress: processedIngressRules,
          description: securityGroupItem.description,
          vpc: typeof vpc === 'object' ? vpc : undefined,
          vpcId: typeof vpc === 'string' ? vpc : undefined,
          tags: securityGroupItem.tags,
        },
      );
      this.addSsmParameter({
        logicalId: pascalCase(`SsmParam${pascalCase(vpcItem.name) + pascalCase(securityGroupItem.name)}SecurityGroup`),
        parameterName: this.getSsmPath(SsmResourceType.SECURITY_GROUP, [vpcItem.name, securityGroupItem.name]),
        stringValue: securityGroup.securityGroupId,
      });
    }

    // AwsSolutions-EC23: The Security Group allows for 0.0.0.0/0 or ::/0 inbound access.
    if (allIngressRule) {
      NagSuppressions.addResourceSuppressions(securityGroup, [
        { id: 'AwsSolutions-EC23', reason: 'User defined an all ingress rule in configuration.' },
      ]);
    }
    return securityGroup;
  }

  /**
   * Lookup same account+region IPAM subnet
   * @param vpcName
   * @param subnetName
   */
  public lookupLocalIpamSubnet(vpcName: string, subnetName: string): IIpamSubnet {
    this.logger.info(`Retrieve IPAM Subnet CIDR for vpc:[${vpcName}] subnet:[${subnetName}]`);

    return IpamSubnet.fromLookup(this, pascalCase(`${vpcName}${subnetName}IpamSubnetLookup`), {
      owningAccountId: cdk.Stack.of(this).account,
      ssmSubnetIdPath: this.getSsmPath(SsmResourceType.SUBNET, [vpcName, subnetName]),
      region: cdk.Stack.of(this).region,
      roleName: this.acceleratorResourceNames.roles.ipamSubnetLookup,
      kmsKey: this.cloudwatchKey,
      logRetentionInDays: this.logRetention,
    });
  }

  /**
   * Set route table destination based on CIDR or subnet reference
   * @param routeTableEntryItem
   * @param subnetMap
   * @param vpcName
   * @returns
   */
  public setRouteEntryDestination(
    routeTableEntryItem: RouteTableEntryConfig,
    ipamSubnetArray: string[],
    vpcName: string,
  ): string {
    const subnetKey = `${vpcName}_${routeTableEntryItem.destination!}`;

    return ipamSubnetArray.includes(subnetKey)
      ? this.lookupLocalIpamSubnet(vpcName, routeTableEntryItem.destination!).ipv4CidrBlock
      : routeTableEntryItem.destination!;
  }

  /**
   * Set site-to-site VPN connection properties.
   * @param options
   * @returns VpnConnectionProps
   */
  public setVpnProps(options: {
    vpnItem: VpnConnectionConfig;
    customerGatewayId: string;
    customResourceHandler?: cdk.aws_lambda.IFunction;
    transitGatewayId?: string;
    virtualPrivateGateway?: string;
  }): VpnConnectionProps {
    return {
      name: options.vpnItem.name,
      customerGatewayId: options.customerGatewayId,
      amazonIpv4NetworkCidr: options.vpnItem.amazonIpv4NetworkCidr,
      customerIpv4NetworkCidr: options.vpnItem.customerIpv4NetworkCidr,
      customResourceHandler: hasAdvancedVpnOptions(options.vpnItem) ? options.customResourceHandler : undefined,
      enableVpnAcceleration: options.vpnItem.enableVpnAcceleration,
      staticRoutesOnly: options.vpnItem.staticRoutesOnly,
      tags: options.vpnItem.tags,
      transitGatewayId: options.transitGatewayId,
      virtualPrivateGateway: options.virtualPrivateGateway,
      vpnTunnelOptionsSpecifications: this.setVpnTunnelOptions(options.vpnItem),
    };
  }

  /**
   * Set VPN tunnel options properties
   * @param vpnItem VpnConnectionConfig
   * @returns VpnTunnelOptionsSpecifications[] | undefined
   */
  private setVpnTunnelOptions(vpnItem: VpnConnectionConfig): VpnTunnelOptionsSpecifications[] | undefined {
    if (!vpnItem.tunnelSpecifications) {
      return;
    }
    const vpnTunnelOptions: VpnTunnelOptionsSpecifications[] = [];

    for (const [index, tunnel] of vpnItem.tunnelSpecifications.entries()) {
      let loggingConfig: { enable?: boolean; logGroupArn?: string; outputFormat?: string } | undefined = undefined;
      let preSharedKeyValue: string | undefined = undefined;
      //
      // Rewrite logging config with log group ARN
      if (tunnel.logging?.enable) {
        loggingConfig = {
          enable: true,
          logGroupArn: this.createVpnLogGroup(vpnItem, index, tunnel.logging.logGroupName),
          outputFormat: tunnel.logging.outputFormat,
        };
      }
      //
      // Rewrite PSK
      if (tunnel.preSharedKey) {
        const preSharedKeySecret = cdk.aws_secretsmanager.Secret.fromSecretNameV2(
          this,
          pascalCase(`${vpnItem.name}${tunnel.preSharedKey}Tunnel${index}PreSharedKeySecret`),
          tunnel.preSharedKey,
        );
        //
        // If advanced VPN, use the ARN. Otherwise, retrieve the secret value
        preSharedKeyValue = hasAdvancedVpnOptions(vpnItem)
          ? preSharedKeySecret.secretArn
          : preSharedKeySecret.secretValue.toString();
      }

      vpnTunnelOptions.push({
        dpdTimeoutAction: tunnel.dpdTimeoutAction,
        dpdTimeoutSeconds: tunnel.dpdTimeoutSeconds,
        ikeVersions: tunnel.ikeVersions,
        logging: loggingConfig,
        phase1: tunnel.phase1,
        phase2: tunnel.phase2,
        preSharedKey: preSharedKeyValue,
        rekeyFuzzPercentage: tunnel.rekeyFuzzPercentage,
        rekeyMarginTimeSeconds: tunnel.rekeyMarginTimeSeconds,
        replayWindowSize: tunnel.replayWindowSize,
        startupAction: tunnel.startupAction,
        tunnelInsideCidr: tunnel.tunnelInsideCidr,
        tunnelLifecycleControl: tunnel.tunnelLifecycleControl,
      });
    }
    return vpnTunnelOptions;
  }

  /**
   * Returns the ARN of a CloudWatch Log group created for the VPN tunnel.
   * @param vpnItem VpnConnectionConfig
   * @param index number
   * @param logGroupName string | undefined
   * @returns string
   */
  private createVpnLogGroup(vpnItem: VpnConnectionConfig, index: number, logGroupName?: string): string {
    return new cdk.aws_logs.LogGroup(this, pascalCase(`${vpnItem.name}Tunnel${index}LogGroup`), {
      logGroupName,
      encryptionKey: this.cloudwatchKey,
      retention: this.logRetention,
    }).logGroupArn;
  }
}
