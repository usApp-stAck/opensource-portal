//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

/*eslint no-console: ["error", { allow: ["warn", "dir", "log"] }] */

import throat from 'throat';

import { createAndInitializeLinkProviderInstance, ILinkProvider } from '../../lib/linkProviders';
import { ICorporateLink } from '../../business/corporateLink';
import { Operations, UnlinkPurpose } from '../../business/operations';
import { sleep } from '../../utils';
import { IReposJob, IReposJobResult } from '../../app';

export default async function refresh({ providers }: IReposJob): Promise<IReposJobResult> {
  const operations = providers.operations as Operations;
  const insights = providers.insights;
  const config = providers.config;
  const linkProvider = await createAndInitializeLinkProviderInstance(providers, config);
  const graphProvider = providers.graphProvider;

  console.log('reading all links');
  const allLinks = await getAllLinks(linkProvider);
  console.log(`READ: ${allLinks.length} links`);
  insights.trackEvent({ name: 'JobRefreshUsernamesReadLinks', properties: { links: String(allLinks.length) } });

  let errors = 0;
  let notFoundErrors = 0;
  let errorList = [];

  let updates = 0;
  let updatedUsernames = 0;
  let updatedAvatars = 0;
  let updatedAadNames = 0;
  let updatedAadUpns = 0; // should be super rare

  const userDetailsThroatCount = 1;
  const secondsDelayAfterError = 5;
  const secondsDelayAfterSuccess = 0.25;

  const maxAgeSeconds = 24 * 60 * 60; // details can be a day out-of-date

  const throttle = throat(userDetailsThroatCount);
  await Promise.all(allLinks.map((link: ICorporateLink) => throttle(async () => {
    // Refresh GitHub username for the ID
    let id = link.thirdPartyId;
    const account = operations.getAccount(id);
    try {
      const refreshOptions = {
        maxAgeSeconds,
        backgroundRefresh: false,
      };
      const details = await account.getDetails(refreshOptions);
      let changed = false;

      if (details.login && link.thirdPartyUsername !== details.login) {
        insights.trackEvent({ name: 'JobRefreshUsernamesUpdateLogin', properties: { old: link.thirdPartyUsername, new: details.login } });
        link.thirdPartyUsername = details.login;
        changed = true;
        ++updatedUsernames;
      }

      if (details.avatar_url && link.thirdPartyAvatar !== details.avatar_url) {
        link.thirdPartyAvatar = details.avatar_url;
        changed = true;
        ++updatedAvatars;
      }

      try {
        const graphInfo = await graphProvider.getUserById(link.corporateId);
        if (graphInfo) {
          if (graphInfo.userPrincipalName && link.corporateUsername !== graphInfo.userPrincipalName) {
            link.corporateUsername = graphInfo.userPrincipalName;
            changed = true;
            ++updatedAadUpns;
          }
          if (graphInfo.displayName && link.corporateDisplayName !== graphInfo.displayName) {
            link.corporateDisplayName = graphInfo.displayName;
            changed = true;
            ++updatedAadNames;
          }
        }
      } catch (graphLookupError) {
        // Ignore graph lookup issues, other jobs handle terminated employees
      }

      if (changed) {
        await updateLink(linkProvider, link);
        console.log(`Updates saved for GitHub user ID ${id}`);
        ++updates;
      }
    } catch (getDetailsError) {
      if (getDetailsError.status == /* loose compare */ '404') {
        ++notFoundErrors;
        insights.trackEvent({ name: 'JobRefreshUsernamesNotFound', properties: { githubid: id, error: getDetailsError.message } });
        try {
          await operations.terminateLinkAndMemberships(id, { purpose: UnlinkPurpose.Deleted });
          insights.trackEvent({ name: 'JobRefreshUsernamesUnlinkDelete', properties: { githubid: id, error: getDetailsError.message } });
        } catch (unlinkDeletedAccountError) {
          console.dir(unlinkDeletedAccountError);
          insights.trackException({ exception: unlinkDeletedAccountError, properties: { githubid: id, event: 'JobRefreshUsernamesDeleteError' } });
        }
      } else {
        ++errors;
        insights.trackException({ exception: getDetailsError, properties: { name: 'JobRefreshUsernamesError' } });
        errorList.push(getDetailsError);
        await sleep(secondsDelayAfterError * 1000);
      }
      return;
    }

    await sleep(secondsDelayAfterSuccess * 1000);

  })));

  console.log('All done with', errors, 'errors. Not found errors:', notFoundErrors);
  console.dir(errorList);
  console.log();

  console.log(`Updates: ${updates}`);
  console.log(`GitHub username changes: ${updatedUsernames}`);
  console.log(`GitHub avatar changes: ${updatedAvatars}`);
  console.log(`AAD name changes: ${updatedAadNames}`);
  console.log(`AAD username changes: ${updatedAadUpns}`);

  return {
    successProperties: {
      updates,
      updatedUsernames,
      updatedAvatars,
      updatedAadNames,
      updatedAadUpns,
      errors,
    },
  };
}

function updateLink(linkProvider: ILinkProvider, link: ICorporateLink): Promise<void> {
  return linkProvider.updateLink(link);
}

function getAllLinks(linkProvider: ILinkProvider): Promise<ICorporateLink[]> {
  return linkProvider.getAll();
}
